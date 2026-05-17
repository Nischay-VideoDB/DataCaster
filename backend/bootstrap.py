"""Import-side-effect module: must be the first import in every server entry point.

Loads .env. Must run before any library that depends on environment vars
(videodb, requests, httpx) is imported in the process.
"""

import asyncio
import logging
import signal
from pathlib import Path
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

log = logging.getLogger("bootstrap")


def _install_sigterm_handler() -> None:
    """Schedule pipeline.stop_pipeline() on the running event loop on SIGTERM.

    Defensive belt over the FastAPI lifespan finally — if the in-flight
    request hangs through the shutdown grace window, this still releases
    the sandbox before the process is killed.
    """
    def _handler(signum, frame):  # noqa: ARG001
        try:
            from . import pipeline
        except Exception:
            return
        if (pipeline.state.sandbox is None
                and pipeline.state.rtstream is None
                and pipeline.state.video is None):
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(pipeline.stop_pipeline())
        except Exception as e:  # noqa: BLE001
            log.warning("SIGTERM stop scheduling failed: %s", e)

    try:
        signal.signal(signal.SIGTERM, _handler)
    except (ValueError, OSError):
        # Not the main thread — uvicorn workers have their own signal handling.
        pass


_install_sigterm_handler()
