"""Sandbox lifecycle helpers.

Sandbox tracking happens via a sidecar file (`/tmp/datacaster_active_sandboxes.txt`)
listing the IDs we have allocated. The sweeper only stops IDs in that file —
we never blind-stop everything `conn.list_sandboxes()` returns, because the
account may host sandboxes from another concurrent run on a different machine.

Lifecycle:
- ``register(sandbox_id)`` is called immediately after ``conn.create_sandbox``.
- ``unregister(sandbox_id)`` is called by ``stop_pipeline`` after the sandbox
  is stopped successfully.
- ``sweep_orphans()`` is called from ``main.lifespan`` startup. For each id
  still in the file, look it up via ``conn.get_sandbox`` and stop it if it
  is in a running state. Returns the count actually stopped.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import videodb

log = logging.getLogger("sandbox")

SIDECAR = Path("/tmp/datacaster_active_sandboxes.txt")


def _read_ids() -> list[str]:
    if not SIDECAR.exists():
        return []
    try:
        return [line.strip() for line in SIDECAR.read_text().splitlines() if line.strip()]
    except OSError:
        return []


def _write_ids(ids: list[str]) -> None:
    try:
        SIDECAR.write_text("\n".join(ids) + ("\n" if ids else ""))
    except OSError as e:
        log.warning("sidecar write failed: %s", e)


def register(sandbox_id: str) -> None:
    """Append a fresh sandbox id to the sidecar."""
    if not sandbox_id:
        return
    ids = _read_ids()
    if sandbox_id not in ids:
        ids.append(sandbox_id)
        _write_ids(ids)


def unregister(sandbox_id: str) -> None:
    """Remove a stopped sandbox id from the sidecar."""
    if not sandbox_id:
        return
    ids = [i for i in _read_ids() if i != sandbox_id]
    _write_ids(ids)


def _stop_sync(conn, sandbox_id: str) -> bool:
    """Best-effort sync stop. True if running→stopped or not on server."""
    try:
        sb = conn.get_sandbox(sandbox_id)
    except Exception as e:  # noqa: BLE001
        log.info("sweep: sandbox %s not on server: %s", sandbox_id, e)
        return True
    status = (getattr(sb, "status", None) or "").lower()
    if status in ("stopped", "terminated", "shutdown"):
        return True
    try:
        sb.stop()
        # bounded so a stuck sandbox doesn't hang shutdown
        try:
            sb.wait_for_stop(timeout=60, interval=5)
        except Exception:
            pass
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("sweep: failed to stop sandbox %s: %s", sandbox_id, e)
        return False


async def sweep_orphans() -> int:
    """Stop every sandbox id in the sidecar, then clear it. Recovers across SIGKILL→restart."""
    ids = _read_ids()
    if not ids:
        return 0

    def _do() -> int:
        try:
            conn = videodb.connect()
        except Exception as e:  # noqa: BLE001
            log.warning("sweep: cannot connect to VideoDB: %s", e)
            return 0
        stopped = 0
        for sandbox_id in ids:
            if _stop_sync(conn, sandbox_id):
                stopped += 1
        # Clear regardless — failures resurface on /api/sandbox/sweep retry.
        _write_ids([])
        return stopped

    return await asyncio.to_thread(_do)
