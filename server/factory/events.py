"""In-process event bus + WebSocket fan-out."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

_subscribers: set[asyncio.Queue] = set()
_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    with _lock:
        _subscribers.discard(q)


def publish(event: str, payload: dict[str, Any] | None = None) -> None:
    msg = {
        "event": event,
        "ts": time.time(),
        "payload": payload or {},
    }
    raw = json.dumps(msg)

    def _fanout() -> None:
        with _lock:
            dead = []
            for q in list(_subscribers):
                try:
                    q.put_nowait(raw)
                except asyncio.QueueFull:
                    try:
                        q.get_nowait()
                    except Exception:
                        pass
                    try:
                        q.put_nowait(raw)
                    except Exception:
                        dead.append(q)
                except Exception:
                    dead.append(q)
            for q in dead:
                _subscribers.discard(q)

    loop = _loop
    if loop and loop.is_running():
        loop.call_soon_threadsafe(_fanout)
    else:
        _fanout()
