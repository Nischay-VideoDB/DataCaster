"""Telegram Bot API client — posts highlight reels to a chat.

Programmable-editing wedge: when DataCaster composes a 9:16 reel from the
last N events plus a `coll.generate_text` recap caption, this module
delivers both to a Telegram chat. The hackathon brief explicitly calls
out *"Compose clips, fire events, and let your agent respond. Wire it
into anything: Slack, the web, a phone."* — Telegram is the phone
endpoint.

Configured by two env vars (`backend/config.py`):
- TELEGRAM_BOT_TOKEN — get one from @BotFather on Telegram
- TELEGRAM_CHAT_ID   — your numeric chat id (use @userinfobot to find it)

When either is unset, `send_reel(...)` returns ``None`` with a single log
warning. The reel itself still ships back to the UI — the user just sees
a "Telegram not configured" hint instead of a delivered badge.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import requests

from .config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ENABLED

log = logging.getLogger("telegram")


# Telegram caption hard cap; we truncate at the last sentence boundary
# below this so a long auto-generated recap doesn't 400.
_CAPTION_MAX_CHARS = 1024


def _truncate_caption(text: str) -> str:
    if len(text) <= _CAPTION_MAX_CHARS:
        return text
    cut = text[: _CAPTION_MAX_CHARS - 1]
    # Prefer a sentence boundary if one is reasonably close.
    boundary = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    if boundary > _CAPTION_MAX_CHARS - 200:
        return cut[: boundary + 1]
    return cut + "…"


def _send_video_sync(reel_url: str, caption: str) -> dict[str, Any] | None:
    """Try /sendVideo. Telegram fetches the URL itself; HLS manifests often 400 → caller falls back."""
    api = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendVideo"
    try:
        r = requests.post(
            api,
            data={
                "chat_id": TELEGRAM_CHAT_ID,
                "video": reel_url,
                "caption": _truncate_caption(caption),
                "supports_streaming": True,
            },
            timeout=30,
        )
    except requests.RequestException as e:
        log.warning("telegram sendVideo network error: %s", e)
        return None
    if r.status_code != 200:
        log.warning("telegram sendVideo returned %d: %s", r.status_code, r.text[:200])
        return None
    body = r.json()
    if not body.get("ok"):
        log.warning("telegram sendVideo not ok: %s", body)
        return None
    msg = body.get("result", {})
    return {"message_id": msg.get("message_id")}


def _send_message_sync(reel_url: str, caption: str) -> dict[str, Any] | None:
    """Fallback when /sendVideo can't ingest the URL — posts caption + clickable link."""
    api = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    body_text = _truncate_caption(caption) + f"\n\n▶ {reel_url}"
    try:
        r = requests.post(
            api,
            data={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": body_text,
                "disable_web_page_preview": False,
            },
            timeout=30,
        )
    except requests.RequestException as e:
        log.warning("telegram sendMessage network error: %s", e)
        return None
    if r.status_code != 200:
        log.warning("telegram sendMessage returned %d: %s", r.status_code, r.text[:200])
        return None
    body = r.json()
    if not body.get("ok"):
        log.warning("telegram sendMessage not ok: %s", body)
        return None
    msg = body.get("result", {})
    return {"message_id": msg.get("message_id")}


async def send_reel(reel_url: str, caption: str) -> dict[str, Any] | None:
    """Deliver a composed reel to the configured Telegram chat.

    Returns ``{"message_id": int}`` on success, or ``None`` if Telegram
    is not configured or both delivery attempts fail. Never raises — the
    calling endpoint always returns the reel URL + caption to the UI so
    the user has a copy-able artifact even when delivery breaks.
    """
    if not TELEGRAM_ENABLED:
        log.info(
            "telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID "
            "missing) — skipping delivery"
        )
        return None

    # sendVideo first — gives a player chip in the chat.
    result = await asyncio.to_thread(_send_video_sync, reel_url, caption)
    if result:
        log.info("telegram sendVideo ok message_id=%s", result.get("message_id"))
        return result

    # Fall back to sendMessage with a link (HLS manifests often fail sendVideo).
    result = await asyncio.to_thread(_send_message_sync, reel_url, caption)
    if result:
        log.info("telegram sendMessage ok message_id=%s", result.get("message_id"))
        return result

    log.warning("telegram delivery failed (both sendVideo and sendMessage)")
    return None
