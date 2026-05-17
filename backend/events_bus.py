"""In-process pub/sub for SSE fanout."""

from __future__ import annotations

import asyncio
from typing import Any


class EventBus:
    """Tiny fanout bus. Each subscriber gets its own bounded queue.

    Slow subscribers drop messages (we never block the producer).
    """

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    def subscribe(self, maxsize: int = 200) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    def publish(self, event: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # drop on slow consumer; the live SSE stream prefers freshness
                pass


bus = EventBus()
