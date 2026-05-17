"""List and stop all active VideoDB sandboxes.

Use when /api/start fails with "Maximum active sandboxes for tier 'medium'
reached" — orphaned sandboxes from earlier crashed runs.

Usage:
    python scripts/stop_sandboxes.py            # interactive: list, then prompt
    python scripts/stop_sandboxes.py --yes      # stop all without prompting
"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import videodb  # noqa: E402

YES = "--yes" in sys.argv

conn = videodb.connect()
sandboxes = conn.list_sandboxes()

if not sandboxes:
    print("no active sandboxes.")
    sys.exit(0)

print(f"found {len(sandboxes)} sandbox(es):")
for sb in sandboxes:
    tier = getattr(sb, "tier", "?")
    status = getattr(sb, "status", "?")
    print(f"  {sb.id}  tier={tier}  status={status}")

if not YES:
    ans = input("\nstop all of them? [y/N] ").strip().lower()
    if ans != "y":
        print("aborted.")
        sys.exit(0)

for sb in sandboxes:
    try:
        sb.stop()
        print(f"  stopped {sb.id}")
    except Exception as e:
        print(f"  failed to stop {sb.id}: {e}")

print("\nwaiting for sandboxes to fully release...")
for sb in sandboxes:
    try:
        sb.wait_for_stop(timeout=120)
    except Exception as e:
        print(f"  {sb.id} wait_for_stop: {e}")

print("done.")
