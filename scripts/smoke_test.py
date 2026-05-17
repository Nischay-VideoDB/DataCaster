"""Sanity-check the VideoDB hackathon SDK + API key.

Run: source .venv/bin/activate && python scripts/smoke_test.py
"""

from dotenv import load_dotenv
load_dotenv()

from videodb import connect

conn = connect()
print(f"connected: {conn}")

coll = conn.get_collection()
print(f"default collection: id={coll.id} name={coll.name}")

videos = coll.get_videos()
print(f"existing videos in collection: {len(videos)}")

print("\nOK — SDK loads, API key authenticates, default collection reachable.")
