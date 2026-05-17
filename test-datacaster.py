"""End-to-end test runner for DataCaster.

Invokes the running backend (default :8000) and frontend (default :3000) and
exercises every public surface — idle, live football, live describe mode, and
the static frontend bundle.

Usage
-----
    python test-datacaster.py                # full run (~11 min)
    python test-datacaster.py --phase A      # idle-only (<10s, no spend)
    python test-datacaster.py --phase B      # football VOD run (~4 min)
    python test-datacaster.py --phase C      # describe-mode VOD run (~3 min)
    python test-datacaster.py --phase D      # frontend bundle reachability
    python test-datacaster.py --phase E      # RTStream live-ingest run (~3 min)
    python test-datacaster.py --phase F      # Telegram delivery probe (~5s)
    python test-datacaster.py --phase G      # sandbox lifecycle (~30s+, USE_SANDBOX gated)

Preconditions
-------------
- Backend healthy at  $DATACASTER_BACKEND  (default http://localhost:8000)
- Frontend served at  $DATACASTER_FRONTEND (default http://localhost:3000)
- VIDEO_DB_API_KEY env var (only needed for B / C / E phases)
- TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars for Phase F. T29 (live
  sendMessage) is gated behind DATACASTER_TELEGRAM_LIVE=1 so test runs
  don't spam the chat — flip it on for a real end-to-end smoke.

Each test logs `[Tnn PASS]` or `[Tnn FAIL: …]`. Final summary line is
machine-readable: `RESULT: passed=N failed=M skipped=K duration=Ds`.

Exit code: 0 on full pass, 1 on any failure or unrecoverable error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator

try:
    import requests
except ImportError as e:  # pragma: no cover
    sys.stderr.write(
        "test-datacaster.py needs `requests` (pip install requests).\n"
    )
    raise SystemExit(2) from e


BACKEND = os.environ.get("DATACASTER_BACKEND", "http://localhost:8000").rstrip("/")
FRONTEND = os.environ.get("DATACASTER_FRONTEND", "http://localhost:3000").rstrip("/")
TEST_VIDEO_URL = os.environ.get(
    "DATACASTER_TEST_URL", "https://youtu.be/DP4epIVQOCk"
)
TEST_RTSP_URL = os.environ.get(
    "DATACASTER_TEST_RTSP", "rtsp://samples.rts.videodb.io:8554/crib"
)
# Phase F (Telegram). Same env vars as the backend; both required for T29.
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# Free-tier indexing can be slow; 6 min is the ceiling.
FIRST_EVENT_TIMEOUT_S = 360.0
INDEX_READY_TIMEOUT_S = 90.0
END_SESSION_TIMEOUT_S = 30.0

# Vocab mirrors of backend/config.py; inline to avoid importing backend deps.
# If config.py drifts, update these — the divergence is the test point.
FOOTBALL_VOCAB = {
    "goal", "shot_on_target", "shot_off_target", "save", "corner", "free_kick",
    "yellow_card", "red_card", "foul", "throw_in", "penalty", "kick_off",
}
GENERIC_VOCAB = {"scene_change", "speaker", "action", "text_overlay"}


# ──────────────────────────────────────────────────────────────────────────
# Tiny test harness — context-manager pattern over unittest.
# ──────────────────────────────────────────────────────────────────────────


class _Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.failures: list[tuple[str, str]] = []


_RESULTS = _Results()


@contextmanager
def step(name: str) -> Iterator[None]:
    """Run a named test step. Logs PASS/FAIL/SKIP and updates _RESULTS."""
    start = time.time()
    try:
        yield
    except _Skip as e:
        _RESULTS.skipped += 1
        elapsed = time.time() - start
        print(f"[{name} SKIP {elapsed:.1f}s] {e}")
        return
    except AssertionError as e:
        _RESULTS.failed += 1
        _RESULTS.failures.append((name, str(e)))
        elapsed = time.time() - start
        print(f"[{name} FAIL {elapsed:.1f}s] {e}")
        return
    except requests.RequestException as e:
        _RESULTS.failed += 1
        _RESULTS.failures.append((name, f"HTTP error: {e}"))
        elapsed = time.time() - start
        print(f"[{name} FAIL {elapsed:.1f}s] HTTP error: {e}")
        return
    except Exception as e:  # noqa: BLE001
        _RESULTS.failed += 1
        _RESULTS.failures.append((name, f"unhandled {type(e).__name__}: {e}"))
        elapsed = time.time() - start
        print(f"[{name} FAIL {elapsed:.1f}s] unhandled {type(e).__name__}: {e}")
        return
    elapsed = time.time() - start
    _RESULTS.passed += 1
    print(f"[{name} PASS {elapsed:.1f}s]")


class _Skip(Exception):
    """Raise to skip a step (e.g. backend unreachable for Phase A)."""


def _get(path: str, **kw: Any) -> requests.Response:
    return requests.get(BACKEND + path, timeout=20, **kw)


def _post(path: str, json_body: Any = None, **kw: Any) -> requests.Response:
    return requests.post(BACKEND + path, json=json_body, timeout=180, **kw)


def _expect_200(r: requests.Response) -> dict[str, Any]:
    assert r.status_code == 200, f"expected 200 got {r.status_code}: {r.text[:200]}"
    return r.json()


def _wait_until(
    predicate: Callable[[], bool], *, timeout_s: float, poll_s: float = 2.0,
    label: str = "predicate",
) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if predicate():
                return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(poll_s)
    raise AssertionError(f"timeout waiting for {label} after {timeout_s:.0f}s")


def _stream_first_event(timeout_s: float) -> dict[str, Any]:
    """Open the SSE feed; return the first `event` payload. AssertionError on timeout."""
    deadline = time.time() + timeout_s
    with requests.get(BACKEND + "/api/events", stream=True, timeout=timeout_s) as r:
        assert r.status_code == 200, f"SSE returned {r.status_code}"
        current_event: str | None = None
        for raw in r.iter_lines(decode_unicode=True):
            if time.time() > deadline:
                break
            if raw is None:
                continue
            line = raw.strip()
            if not line:
                current_event = None
                continue
            if line.startswith("event:"):
                current_event = line.split(":", 1)[1].strip()
                continue
            if line.startswith("data:"):
                payload_text = line.split(":", 1)[1].strip()
                if current_event != "event":
                    continue
                try:
                    payload = json.loads(payload_text)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "event":
                    return payload
    raise AssertionError(f"no SSE 'event' message received within {timeout_s:.0f}s")


def _end_session() -> None:
    """Best-effort end-session. Not a test step itself — used as a teardown."""
    try:
        requests.post(BACKEND + "/api/end_session", timeout=END_SESSION_TIMEOUT_S)
    except Exception:  # noqa: BLE001
        pass


# ──────────────────────────────────────────────────────────────────────────
# Phase A — idle assertions. No VideoDB API spend, runs in <10s.
# ──────────────────────────────────────────────────────────────────────────


def phase_a() -> None:
    print("\n=== Phase A — idle assertions ===")

    # Clear residual state. end_session is idempotent.
    _end_session()

    with step("T01 health idle"):
        d = _expect_200(_get("/api/health"))
        assert d["status"] == "ok"
        p = d["pipeline"]
        assert p["started_at"] is None, f"pipeline still running (started_at={p['started_at']})"
        assert p["content_type"] in ("football", "describe"), p["content_type"]

    with step("T02 stats empty"):
        d = _expect_200(_get("/api/stats"))
        assert d["counts"] == {}, f"stats not empty: {d['counts']}"
        assert d["total"] == 0

    with step("T03 events history empty"):
        d = _expect_200(_get("/api/events/history?limit=200"))
        assert d["events"] == [], f"history not empty: {len(d['events'])} rows"

    with step("T04 commentary track empty"):
        d = _expect_200(_get("/api/commentary/track?limit=50"))
        assert d["items"] == [], f"commentary not empty: {len(d['items'])}"
        assert "voice" in d, "voice status missing"
        assert isinstance(d["voice"]["available"], bool)

    with step("T05 highlights empty"):
        d = _expect_200(_get("/api/highlights?limit=25"))
        assert d.get("items", []) == [], f"highlights not empty"

    with step("T06 end_session idempotent"):
        d = _expect_200(_post("/api/end_session"))
        assert d["status"] == "ended"

    with step("T07 invalid content_type rejected"):
        r = _post("/api/start", {
            "source_type": "video",
            "source": TEST_VIDEO_URL,
            "content_type": "obviously_invalid",
        })
        assert r.status_code == 422, (
            f"expected 422 for invalid content_type, got {r.status_code}: {r.text[:200]}"
        )


# ──────────────────────────────────────────────────────────────────────────
# Phase B — live football run. ~3-5 min. Consumes VideoDB credits.
# ──────────────────────────────────────────────────────────────────────────


def phase_b() -> None:
    print("\n=== Phase B — live football run ===")

    if not os.environ.get("VIDEO_DB_API_KEY"):
        print("[Phase B SKIP] VIDEO_DB_API_KEY not set")
        _RESULTS.skipped += 8  # T08-T15
        return

    _end_session()
    time.sleep(1.0)

    started_at: float | None = None

    with step("T08 start football pipeline"):
        d = _expect_200(_post("/api/start", {
            "source_type": "video",
            "source": TEST_VIDEO_URL,
            "content_type": "football",
        }))
        assert d["content_type"] == "football"
        assert d["video_id"] and d["video_id"].startswith("m-"), f"unexpected video_id={d['video_id']}"
        assert d["started_at"] is not None
        nonlocal_started_at = d["started_at"]
        globals()["__phase_b_started_at"] = nonlocal_started_at

    with step("T09 wait for VOD scene + transcript indexes"):
        def indexes_ready() -> bool:
            d = _expect_200(_get("/api/health"))
            p = d["pipeline"]
            return (
                bool(p.get("vod_scene_index_id"))
                and p.get("transcript_index_id") == "spoken_word"
            )
        _wait_until(indexes_ready, timeout_s=INDEX_READY_TIMEOUT_S,
                    label="scene + transcript indexes")

    with step("T10 first SSE event arrives"):
        evt = _stream_first_event(timeout_s=FIRST_EVENT_TIMEOUT_S)
        assert evt["type"] == "event"
        assert "event" in evt and isinstance(evt["event"], dict)
        globals()["__phase_b_first_event"] = evt["event"]

    with step("T11 timestamps line up (regression test for VOD race)"):
        d = _expect_200(_get("/api/events/history?limit=10"))
        assert d["events"], "history empty after first SSE event"
        e = d["events"][-1]  # oldest of the recent 10
        started_at = globals().get("__phase_b_started_at")
        assert started_at is not None, "Phase B started_at not set"
        # Bug 1 regression: if VOD race regresses, unix_ts sits BEFORE started_at and this fails.
        elapsed = time.time() - started_at
        offset = e["unix_ts"] - started_at
        assert offset >= -0.1, f"event ts BEFORE started_at by {-offset:.2f}s — VOD race regressed"
        assert offset <= elapsed + 5.0, (
            f"event offset {offset:.1f}s exceeds pipeline elapsed {elapsed:.1f}s"
        )
        assert e["event_type"] in FOOTBALL_VOCAB, (
            f"event_type {e['event_type']!r} not in football vocab"
        )

    with step("T12 stats reflect football vocab only"):
        # Wait for ≥3 events so the deduper sees real spread.
        def have_three() -> bool:
            d = _expect_200(_get("/api/stats"))
            return d["total"] >= 3
        _wait_until(have_three, timeout_s=120.0, label="3 events")
        d = _expect_200(_get("/api/stats"))
        assert d["total"] >= 3
        for k in d["counts"]:
            assert k in FOOTBALL_VOCAB, (
                f"unexpected football-mode event_type {k!r}; counts={d['counts']}"
            )

    with step("T13 search returns shots"):
        d = _expect_200(_get("/api/search?q=goal&kind=visual&threshold=10"))
        assert d["q"] == "goal"
        assert d["kind"] == "visual"
        # Shots may be empty mid-indexing; just require valid shape.
        assert isinstance(d["shots"], list)
        for s in d["shots"][:3]:
            assert "start" in s and "end" in s
            assert isinstance(s.get("stream_url"), (str, type(None)))

    with step("T14 ask returns within 30s with answer or evidence"):
        # Accept either a composed `answer` OR non-empty `evidence` (LLM rate-limited fallback).
        t0 = time.time()
        r = _post("/api/ask", {"q": "did anyone get a card?", "threshold": 6})
        elapsed = time.time() - t0
        d = _expect_200(r)
        assert elapsed < 32.0, f"/api/ask took {elapsed:.1f}s (must be ≤ 30s + small slack)"
        assert isinstance(d.get("answer"), str)
        evidence = d.get("evidence") or []
        assert d["answer"].strip() or evidence, (
            "/api/ask returned neither an answer nor evidence"
        )

    with step("T15 end_session wipes everything"):
        _expect_200(_post("/api/end_session"))
        h = _expect_200(_get("/api/events/history?limit=200"))
        assert h["events"] == [], "events not wiped after end_session"
        s = _expect_200(_get("/api/stats"))
        assert s["total"] == 0, f"stats not zeroed after end_session: {s}"
        c = _expect_200(_get("/api/commentary/track?limit=50"))
        assert c["items"] == [], "commentary not wiped after end_session"


# ──────────────────────────────────────────────────────────────────────────
# Phase C — describe-mode run. ~3 min. The "no football leak" regression test.
# ──────────────────────────────────────────────────────────────────────────


def phase_c() -> None:
    print("\n=== Phase C — describe-mode run ===")

    if not os.environ.get("VIDEO_DB_API_KEY"):
        print("[Phase C SKIP] VIDEO_DB_API_KEY not set")
        _RESULTS.skipped += 4  # T16-T19
        return

    _end_session()
    time.sleep(1.0)

    with step("T16 start describe pipeline"):
        d = _expect_200(_post("/api/start", {
            "source_type": "video",
            "source": TEST_VIDEO_URL,
            "content_type": "describe",
        }))
        assert d["content_type"] == "describe", (
            f"server didn't honour content_type=describe: {d.get('content_type')}"
        )
        assert d["started_at"] is not None

    with step("T17 events use generic vocab — NO football leak"):
        evt = _stream_first_event(timeout_s=FIRST_EVENT_TIMEOUT_S)
        et = evt["event"]["event_type"]
        # Bug 2 regression: describe-mode must never emit football event_types.
        assert et in GENERIC_VOCAB, (
            f"event_type {et!r} is in football vocab while content_type=describe — leak regressed"
        )
        assert et not in FOOTBALL_VOCAB

    with step("T18 commentary disabled in describe mode"):
        time.sleep(5.0)
        d = _expect_200(_get("/api/commentary/track?limit=50"))
        assert d["items"] == [], (
            f"commentary fired in describe mode: {len(d['items'])} items"
        )

    with step("T19 end_session"):
        _expect_200(_post("/api/end_session"))


# ──────────────────────────────────────────────────────────────────────────
# Phase D — frontend bundle reachability. <5s.
# ──────────────────────────────────────────────────────────────────────────


def phase_d() -> None:
    print("\n=== Phase D — frontend reachability ===")

    with step("T20 frontend bundle served"):
        try:
            r = requests.get(FRONTEND + "/", timeout=5)
        except requests.RequestException as e:
            raise _Skip(f"frontend unreachable at {FRONTEND}: {e}")
        assert r.status_code == 200, f"frontend returned {r.status_code}"
        index_html = r.text
        assert "DataCaster" in index_html, "frontend HTML missing 'DataCaster'"
        # Pull the bundled JS chunk to confirm shipped code (HTML shell is just <head>+<div id=root>).
        import re as _re
        m = _re.search(r'src="(/assets/[^"]+\.js)"', index_html)
        assert m, "no /assets/*.js script tag in index.html"
        bundle_path = m.group(1)
        rb = requests.get(FRONTEND + bundle_path, timeout=10)
        assert rb.status_code == 200, f"bundle {bundle_path} returned {rb.status_code}"
        bundle = rb.text
        assert "End session" in bundle, (
            f"bundle {bundle_path} missing 'End session' — bundle may be stale"
        )
        assert "Reel last 3" in bundle, (
            f"bundle {bundle_path} missing 'Reel last 3' — reel button not deployed"
        )

    with step("T21 nginx /api/* proxy works"):
        try:
            r = requests.get(FRONTEND + "/api/health", timeout=5)
        except requests.RequestException as e:
            raise _Skip(f"frontend /api proxy unreachable: {e}")
        assert r.status_code == 200, f"proxied /api/health returned {r.status_code}"
        assert "pipeline" in r.json(), "proxied /api/health missing pipeline field"


# ──────────────────────────────────────────────────────────────────────────
# Phase E — RTStream live ingest. ~3 min. Verifies the live-ingest leg
# the hackathon brief flags as mandatory alongside Search/Memory.
# ──────────────────────────────────────────────────────────────────────────


def phase_e() -> None:
    print("\n=== Phase E — live RTStream ===")

    if not os.environ.get("VIDEO_DB_API_KEY"):
        print("[Phase E SKIP] VIDEO_DB_API_KEY not set")
        _RESULTS.skipped += 5  # T22-T26
        return

    _end_session()
    time.sleep(1.0)

    with step("T22 start RTStream pipeline"):
        d = _expect_200(_post("/api/start", {
            "source_type": "url",
            "source": TEST_RTSP_URL,
            # Baby-monitor feed → describe mode (football vocab would be empty).
            "content_type": "describe",
        }))
        assert d["source_type"] == "url", f"server didn't honour url source: {d.get('source_type')}"
        assert d["started_at"] is not None, "started_at not pinned on rtstream branch"
        assert d.get("rtstream_id"), f"no rtstream_id after start: {d}"

    with step("T23 wait for visual_index_id"):
        def index_ready() -> bool:
            d = _expect_200(_get("/api/health"))
            p = d["pipeline"]
            return bool(p.get("rtstream_id") and p.get("visual_index_id"))
        _wait_until(index_ready, timeout_s=INDEX_READY_TIMEOUT_S,
                    label="rtstream visual index")

    with step("T24 first SSE event arrives (live)"):
        # RTStream first event ~30s after start; 90s headroom.
        evt = _stream_first_event(timeout_s=90.0)
        assert evt["type"] == "event"

    with step("T25 search returns shots on the live feed"):
        d = _expect_200(_get("/api/search?q=person&kind=visual&threshold=10"))
        assert d["kind"] == "visual"
        assert isinstance(d["shots"], list)

    with step("T26 end_session releases the rtstream"):
        _expect_200(_post("/api/end_session"))
        time.sleep(1.0)
        h = _expect_200(_get("/api/health"))
        assert h["pipeline"]["rtstream_id"] is None, "rtstream_id not cleared on end"
        assert h["pipeline"]["started_at"] is None, "started_at not cleared on end"


# ──────────────────────────────────────────────────────────────────────────
# Phase F — Telegram delivery. ~5s, no VideoDB cost.
# T27 getMe · T28 sendChatAction · T29 sendMessage (gated by DATACASTER_TELEGRAM_LIVE=1) · T30 reel idle 400
# ──────────────────────────────────────────────────────────────────────────


def _telegram_url(method: str) -> str:
    return f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}"


def phase_f() -> None:
    print("\n=== Phase F — Telegram delivery ===")

    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("[Phase F SKIP] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
        _RESULTS.skipped += 4  # T27-T30
        return

    with step("T27 getMe — bot token is valid"):
        try:
            r = requests.get(_telegram_url("getMe"), timeout=10)
        except requests.RequestException as e:
            raise AssertionError(f"network error talking to Telegram: {e}") from None
        assert r.status_code == 200, (
            f"getMe returned {r.status_code}: {r.text[:200]}"
        )
        body = r.json()
        assert body.get("ok"), f"getMe not ok: {body}"
        bot = body.get("result", {})
        assert bot.get("id"), f"getMe missing bot id: {body}"
        assert bot.get("is_bot") is True, f"getMe says is_bot=False: {body}"
        print(f"      ↪ bot @{bot.get('username','?')} (id={bot.get('id')})")

    with step("T28 sendChatAction — chat id is reachable"):
        # sendChatAction shows "typing…" briefly; no visible message.
        try:
            r = requests.post(
                _telegram_url("sendChatAction"),
                data={"chat_id": TELEGRAM_CHAT_ID, "action": "typing"},
                timeout=10,
            )
        except requests.RequestException as e:
            raise AssertionError(f"network error talking to Telegram: {e}") from None
        assert r.status_code == 200, (
            f"sendChatAction returned {r.status_code}: {r.text[:200]}\n"
            "If you see 'chat not found' the bot hasn't been added to "
            "TELEGRAM_CHAT_ID, or the chat id is stale."
        )
        body = r.json()
        assert body.get("ok"), f"sendChatAction not ok: {body}"

    with step("T29 sendMessage — live smoke (opt-in via DATACASTER_TELEGRAM_LIVE=1)"):
        if os.environ.get("DATACASTER_TELEGRAM_LIVE", "") != "1":
            raise _Skip(
                "DATACASTER_TELEGRAM_LIVE != 1 — skipping live send so the "
                "test doesn't spam the chat. Re-run with the flag to verify "
                "end-to-end delivery."
            )
        text = (
            "🤖 DataCaster smoke test\n\n"
            "Phase F · sendMessage round-trip via /api/highlights/reel's "
            "delivery client. If you see this in your chat, Telegram "
            "delivery is wired correctly."
        )
        try:
            r = requests.post(
                _telegram_url("sendMessage"),
                data={"chat_id": TELEGRAM_CHAT_ID, "text": text,
                      "disable_notification": True},
                timeout=15,
            )
        except requests.RequestException as e:
            raise AssertionError(f"network error talking to Telegram: {e}") from None
        assert r.status_code == 200, (
            f"sendMessage returned {r.status_code}: {r.text[:200]}"
        )
        body = r.json()
        assert body.get("ok"), f"sendMessage not ok: {body}"
        msg_id = body.get("result", {}).get("message_id")
        assert msg_id, f"sendMessage missing message_id: {body}"
        print(f"      ↪ delivered message_id={msg_id}")

    with step("T30 /api/highlights/reel idle returns 400"):
        # Reel endpoint must refuse without an active pipeline.
        _end_session()
        time.sleep(0.5)
        r = _post("/api/highlights/reel", {"n": 3, "aspect": "vertical", "deliver": "telegram"})
        assert r.status_code == 400, (
            f"expected 400 for idle pipeline, got {r.status_code}: {r.text[:200]}"
        )


# ──────────────────────────────────────────────────────────────────────────
# Phase G — sandbox lifecycle. ~30s when USE_SANDBOX=true, otherwise just
# verifies the manual sweep endpoint registers and returns.
# ──────────────────────────────────────────────────────────────────────────


def phase_g() -> None:
    print("\n=== Phase G — sandbox lifecycle ===")

    with step("T31 /api/sandbox/sweep returns 200"):
        r = _post("/api/sandbox/sweep", {})
        d = _expect_200(r)
        assert "stopped" in d, f"sweep response missing 'stopped': {d}"
        assert isinstance(d["stopped"], int)

    # T32+T33 need a real sandbox allocation; require VIDEO_DB_API_KEY.
    if not os.environ.get("VIDEO_DB_API_KEY"):
        print("[Phase G SKIP after T31] VIDEO_DB_API_KEY not set")
        return

    with step("T32 start with sandbox produces sandbox_id (skips on USE_SANDBOX=false)"):
        # Same VOD source as Phase B to leverage event cache.
        _post(
            "/api/start",
            {"source_type": "video", "source": TEST_VIDEO_URL, "content_type": "football"},
        )
        # Up to 60s for sandbox.wait_for_ready.
        def started_or_idle() -> bool:
            d = _expect_200(_get("/api/health"))
            p = d["pipeline"]
            return p.get("started_at") is not None
        try:
            _wait_until(started_or_idle, timeout_s=300.0, label="pipeline start")
        except _Skip as e:
            raise e
        d = _expect_200(_get("/api/health"))
        sandbox_id = d["pipeline"].get("sandbox_id")
        if not sandbox_id:
            raise _Skip("USE_SANDBOX appears false (no sandbox_id) — T33 skipped too")
        globals()["__phase_g_sandbox_id"] = sandbox_id
        print(f"      ↪ allocated sandbox_id={sandbox_id}")

    with step("T33 end_session releases sandbox + clears sidecar"):
        _expect_200(_post("/api/end_session"))
        # Re-sweep should report stopped=0 (end_session already released).
        time.sleep(2.0)
        r = _post("/api/sandbox/sweep", {})
        d = _expect_200(r)
        assert d["stopped"] == 0, (
            f"end_session leaked a sandbox; sweep reports stopped={d['stopped']}"
        )


# ──────────────────────────────────────────────────────────────────────────
# Driver
# ──────────────────────────────────────────────────────────────────────────


def _check_backend_or_die() -> None:
    try:
        r = requests.get(BACKEND + "/api/health", timeout=3)
        r.raise_for_status()
    except requests.RequestException as e:
        sys.stderr.write(
            f"FATAL: backend not reachable at {BACKEND}: {e}\n"
            f"Start it with `make rebuild` or `make up` and try again.\n"
        )
        raise SystemExit(2) from None


def main() -> int:
    global TEST_VIDEO_URL, TEST_RTSP_URL  # noqa: PLW0603 — reassigned after argparse
    parser = argparse.ArgumentParser(description=__doc__.strip().split("\n")[0])
    parser.add_argument(
        "--phase", choices=["A", "B", "C", "D", "E", "F", "G", "all"], default="all",
        help="Which phase to run (default: all). 'A' is the fast idle suite.",
    )
    parser.add_argument(
        "--video", default=TEST_VIDEO_URL,
        help=f"Video URL for Phases B+C (default: {TEST_VIDEO_URL})",
    )
    parser.add_argument(
        "--rtsp", default=TEST_RTSP_URL,
        help=f"RTSP URL for Phase E (default: {TEST_RTSP_URL})",
    )
    args = parser.parse_args()
    TEST_VIDEO_URL = args.video
    TEST_RTSP_URL = args.rtsp

    print(f"DataCaster e2e test — backend={BACKEND}  frontend={FRONTEND}")
    print(f"Phase: {args.phase}  TestVideo: {TEST_VIDEO_URL}  RTSP: {TEST_RTSP_URL}")
    _check_backend_or_die()

    t0 = time.time()
    phases = {
        "A": phase_a, "B": phase_b, "C": phase_c,
        "D": phase_d, "E": phase_e, "F": phase_f, "G": phase_g,
    }
    if args.phase == "all":
        for name in ("A", "B", "C", "D", "E", "F", "G"):
            phases[name]()
    else:
        phases[args.phase]()

    duration = int(time.time() - t0)
    print()
    print(f"RESULT: passed={_RESULTS.passed} failed={_RESULTS.failed} "
          f"skipped={_RESULTS.skipped} duration={duration}s")
    if _RESULTS.failures:
        print("\nFailures:")
        for name, why in _RESULTS.failures:
            print(f"  {name}: {why}")

    # Cleanup so a failed run doesn't leak a paid pipeline.
    _end_session()

    return 0 if _RESULTS.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
