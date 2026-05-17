#!/usr/bin/env python3
"""Launcher that runs the unmodified skill ws_listener.py."""

import runpy
import sys
from pathlib import Path

if sys.platform == "win32":
    # ProactorEventLoop.add_signal_handler raises NotImplementedError; skill
    # registers SIGINT/SIGTERM at startup. Parent uses taskkill /F.
    import asyncio
    asyncio.windows_events.ProactorEventLoop.add_signal_handler = (
        lambda self, *args, **kwargs: None
    )

REPO_ROOT = Path(__file__).resolve().parent.parent
# .claude symlink first; .agents fallback for Windows clones without symlinks.
SKILL_CANDIDATES = [
    REPO_ROOT / ".claude" / "skills" / "videodb" / "scripts" / "ws_listener.py",
    REPO_ROOT / ".agents" / "skills" / "videodb" / "scripts" / "ws_listener.py",
]
SKILL_LISTENER = next((p for p in SKILL_CANDIDATES if p.is_file()), None)

if SKILL_LISTENER is None:
    print(
        "ERROR: skill ws_listener missing. Tried:\n  "
        + "\n  ".join(str(p) for p in SKILL_CANDIDATES),
        file=sys.stderr,
    )
    sys.exit(1)

# Forward CLI args.
sys.argv = [str(SKILL_LISTENER), *sys.argv[1:]]
runpy.run_path(str(SKILL_LISTENER), run_name="__main__")
