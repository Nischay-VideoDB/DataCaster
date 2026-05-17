"""Centralised runtime configuration for DataCaster."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parent.parent

# Default to /tmp on POSIX (matches Docker + existing kill_all.sh paths) and to
# the OS temp dir on Windows (no /tmp). Override with VIDEODB_EVENTS_DIR.
_DEFAULT_EVENTS_DIR = tempfile.gettempdir() if sys.platform == "win32" else "/tmp"
EVENTS_DIR = Path(os.environ.get("VIDEODB_EVENTS_DIR", _DEFAULT_EVENTS_DIR))
EVENTS_FILE = EVENTS_DIR / "videodb_events.jsonl"
WS_ID_FILE = EVENTS_DIR / "videodb_ws_id"
WS_PID_FILE = EVENTS_DIR / "videodb_ws_pid"
CLASSIFIER_OFFSET_FILE = EVENTS_DIR / "datacaster_offset"
PUB_PIDFILE = EVENTS_DIR / "datacaster_publisher_pid"
MTX_PIDFILE = EVENTS_DIR / "datacaster_mediamtx_pid"

# Persistent logs under logs/<platform>/. Override with DATACASTER_LOG_DIR.
# PID files + events JSONL stay in EVENTS_DIR (working state).
_PLATFORM_LOG_SUBDIR = "windows" if sys.platform == "win32" else "mac"
LOG_DIR = Path(os.environ.get("DATACASTER_LOG_DIR", REPO_ROOT / "logs" / _PLATFORM_LOG_SUBDIR))
LOG_DIR.mkdir(parents=True, exist_ok=True)

WS_LISTENER_LOG = LOG_DIR / "ws_listener.log"
MTX_LOG = LOG_DIR / "mediamtx.log"
PIPELINE_LOG = LOG_DIR / "pipeline.log"
PUBLISHER_LOG = LOG_DIR / "publisher.log"

DB_PATH = REPO_ROOT / "datacaster.db"

# Telegram delivery for the programmable-editing wedge. When both env vars
# are set, /api/highlights/reel posts the composed 9:16 reel + auto-generated
# recap caption to the configured chat. When unset, the endpoint still
# returns the reel + caption to the UI — only the delivery is skipped.
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_ENABLED = bool(TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)

# Sandbox toggle. When false, the SDK uses VideoDB default models.
USE_SANDBOX = os.environ.get("USE_SANDBOX", "false").lower() in ("1", "true", "yes")
SANDBOX_TIER = os.environ.get("SANDBOX_TIER", "medium")

# Indexer model names. SDK picks defaults when USE_SANDBOX is false.
VISUAL_MODEL = os.environ.get("VISUAL_MODEL", "google/gemma-4-31B-it")
AUDIO_MODEL = os.environ.get("AUDIO_MODEL", "Qwen/Qwen3.5-9B")
VOICE_MODEL = os.environ.get("VOICE_MODEL", "k2-fsa/OmniVoice")

# Visual indexing cadence — every N seconds, sample F frames per window.
VISUAL_BATCH_SEC = int(os.environ.get("VISUAL_BATCH_SEC", "2"))
VISUAL_FRAME_COUNT = int(os.environ.get("VISUAL_FRAME_COUNT", "3"))
AUDIO_BATCH_SEC = int(os.environ.get("AUDIO_BATCH_SEC", "30"))

# Default test source. Overridable via /api/start payload.
DEFAULT_SOURCE_TYPE: Literal["file", "url", "youtube"] = os.environ.get(
    "DEFAULT_SOURCE_TYPE", "file"
)  # type: ignore[assignment]
# Movies/ on macOS, Videos/ on Windows — pick whichever exists.
_DEFAULT_VIDEO_DIR = (
    Path.home() / "Movies" if (Path.home() / "Movies").exists() else Path.home() / "Videos"
)
DEFAULT_SOURCE = os.environ.get("DEFAULT_SOURCE", str(_DEFAULT_VIDEO_DIR / "match.mp4"))

# Local mediamtx publish target — used by file source mode and by the YouTube
# fallback path (yt-dlp | ffmpeg | mediamtx).
LOCAL_RTMP_URL = "rtmp://localhost:1935/live/match"

# Commentary worker thresholds.
COMMENTARY_EVENT_TYPES = {"goal", "red_card", "penalty", "save", "shot_on_target", "corner"}
COMMENTARY_MIN_CONFIDENCE = 0.5

# Football event vocabulary (content_type="football"). Order is informational.
EVENT_VOCAB: dict[str, str] = {
    "goal": "A goal is scored: the ball fully crosses the goal line into the net.",
    "shot_on_target": "A player attempts a shot that goes towards the goal frame and is either saved or hits the post.",
    "shot_off_target": "A player attempts a shot that misses the goal frame (wide or over).",
    "save": "The goalkeeper makes a save by stopping or deflecting a shot.",
    "corner": "A corner kick is awarded; a player places the ball at the corner arc.",
    "free_kick": "A free kick is awarded outside the penalty area; players form a wall or set up.",
    "yellow_card": "A referee shows a yellow card to a player.",
    "red_card": "A referee shows a red card to a player.",
    "foul": "A foul is committed; the referee blows the whistle and signals the infringement.",
    "throw_in": "A throw-in is taken by a player from the touchline with both hands above the head.",
    "penalty": "A penalty kick is being taken from the penalty spot.",
    "kick_off": "The match or a half restarts from the centre circle after a goal or at start.",
}

# Generic scene-description vocabulary (content_type="describe") for non-football videos.
# Model picks the single most prominent activity per window; empty/static → "none" → filtered.
GENERIC_VOCAB: dict[str, str] = {
    "scene_change": "A visible cut or transition to a clearly different setting / camera / subject.",
    "speaker": "One or more people speaking on camera (interview, podcast, monologue, panel).",
    "action": "Visible physical activity or motion (cooking, sport, demonstration, walking).",
    "text_overlay": "On-screen graphics, captions, lower-third banners, slide content, or chart overlays.",
}

# content_type -> vocab. Keys must be lowercase ASCII (used as URL/path fragments).
VOCAB_BY_MODE: dict[str, dict[str, str]] = {
    "football": EVENT_VOCAB,
    "describe": GENERIC_VOCAB,
}

# Adding a mode = one line each in this tuple, VOCAB_BY_MODE, and prompts.VISUAL_PROMPTS.
SUPPORTED_CONTENT_TYPES: tuple[str, ...] = ("football", "describe")
DEFAULT_CONTENT_TYPE: str = "football"
