#!/usr/bin/env python3
"""Force-wipe every active VideoDB sandbox on this account.

Usage:
    python scripts/wipe_sandboxes.py              # dry-run, list only
    python scripts/wipe_sandboxes.py --yes        # actually stop them
    python scripts/wipe_sandboxes.py --yes --tier medium   # filter by tier

For each non-stopped sandbox, walks every known stop path (SDK + REST) and
prints each attempt. `alert`-state sandboxes are server-side stuck; the
script still tries every path so you have a full failure log for support.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Load .env so VIDEO_DB_API_KEY is available without explicit export.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

import videodb  # noqa: E402

STOPPED_STATES = {"stopped", "terminated", "shutdown", "shutting_down"}


def _try(label: str, fn) -> tuple[bool, str]:
    try:
        result = fn()
        return True, f"OK ({type(result).__name__})"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {str(e)[:140]}"


def stop_sandbox(conn, sb) -> bool:
    """Try every stop path we know. Returns True if any succeeded."""
    sid = sb.id
    print(f"\n→ {sid}  (status={sb.status}, tier={getattr(sb, 'tier', '?')})")

    paths = [
        ("sb.stop()",                 lambda: sb.stop()),
        ("sb.stop(grace=False)",      lambda: sb.stop(grace=False)),
        ("POST sandbox/<id>/stop",    lambda: conn.post(path=f"sandbox/{sid}/stop", data={"grace": False})),
        ("POST sandbox/<id>/shutdown", lambda: conn.post(path=f"sandbox/{sid}/shutdown", data={})),
        ("DELETE sandbox/<id>",       lambda: conn.delete(path=f"sandbox/{sid}")),
    ]
    for label, fn in paths:
        ok, msg = _try(label, fn)
        marker = "✓" if ok else "✗"
        print(f"   {marker} {label:36s} {msg}")
        if ok:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true",
                        help="Actually stop. Without this flag, only lists.")
    parser.add_argument("--tier", default=None,
                        help="Only act on sandboxes of this tier (small / medium).")
    parser.add_argument("--id", action="append", default=[],
                        help="Limit to specific sandbox id(s). May repeat.")
    args = parser.parse_args()

    if not os.environ.get("VIDEO_DB_API_KEY"):
        sys.stderr.write("FATAL: VIDEO_DB_API_KEY not set (export it or put it in .env)\n")
        return 2

    conn = videodb.connect()
    sandboxes = conn.list_sandboxes()
    print(f"Found {len(sandboxes)} sandbox records on the account.\n")

    by_status: dict[str, list] = {}
    for sb in sandboxes:
        s = (getattr(sb, "status", "") or "unknown").lower()
        by_status.setdefault(s, []).append(sb)
    for s in sorted(by_status):
        print(f"  {s:12s} {len(by_status[s])}")
    print()

    targets = []
    for sb in sandboxes:
        s = (getattr(sb, "status", "") or "unknown").lower()
        if s in STOPPED_STATES:
            continue
        if args.tier and (getattr(sb, "tier", None) or "").lower() != args.tier.lower():
            continue
        if args.id and sb.id not in args.id:
            continue
        targets.append(sb)

    if not targets:
        print("Nothing to do — no active sandboxes match the filter.")
        return 0

    print(f"{len(targets)} active sandbox(es) match the filter:")
    for sb in targets:
        print(f"  {sb.id}  status={sb.status}  tier={getattr(sb, 'tier', '?')}")

    if not args.yes:
        print("\nDRY RUN — re-run with --yes to actually stop them.")
        return 0

    print("\nStopping…")
    stopped = 0
    failed: list[str] = []
    for sb in targets:
        if stop_sandbox(conn, sb):
            stopped += 1
        else:
            failed.append(sb.id)

    print()
    print(f"Done. stopped={stopped} failed={len(failed)}")
    if failed:
        print("\nServer-side stuck — none of the stop paths worked:")
        for sid in failed:
            print(f"  {sid}")
        print(
            "\nOptions:\n"
            "  1. Wait — `alert` state often clears in 15-30 min; rerun later.\n"
            "  2. Force-stop from console.videodb.io.\n"
            "  3. Message hackathon support with these ids."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
