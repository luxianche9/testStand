"""Thread-safe, sequence-numbered ring buffer backing streams and ``stream_read``."""

from __future__ import annotations

import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from itertools import islice
from typing import Any


@dataclass(frozen=True)
class ReadResult:
    items: list[dict[str, Any]]
    next: int
    head: int
    tail: int
    dropped: tuple[int, int] | None = None
    """``(from, to)`` sequence range evicted before the reader got to it."""
    reset: bool = False
    """The cursor was ahead of this buffer (another server epoch); reading restarted at ``tail``."""


class RingBuffer:
    """Entries are ``{"seq", "t", **fields}``; ``seq`` increases monotonically from 0.

    ``tail`` is the oldest retained sequence and ``head`` the next one to be
    assigned. Cursors are sequence numbers, so readers never consume data and
    any number of readers (WebSocket subscribers, ``stream_read``) can share it.
    Eviction happens by item count and, optionally, by summed ``weight``.
    """

    def __init__(self, capacity: int = 4096, *, max_weight: int | None = None) -> None:
        if capacity < 1:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self.max_weight = max_weight
        self.epoch = secrets.token_hex(4)
        self._items: deque[tuple[dict[str, Any], int]] = deque()
        self._weight = 0
        self._next = 0
        self._lock = threading.Lock()

    @property
    def head(self) -> int:
        with self._lock:
            return self._next

    @property
    def tail(self) -> int:
        with self._lock:
            return self._tail()

    def _tail(self) -> int:
        return self._items[0][0]["seq"] if self._items else self._next

    def append(self, fields: dict[str, Any], *, weight: int = 0, t: float | None = None) -> dict[str, Any]:
        with self._lock:
            entry = {"seq": self._next, "t": time.time() if t is None else t, **fields}
            self._next += 1
            self._items.append((entry, weight))
            self._weight += weight
            while len(self._items) > self.capacity or (
                self.max_weight is not None and self._weight > self.max_weight and len(self._items) > 1
            ):
                _, evicted = self._items.popleft()
                self._weight -= evicted
            return entry

    def read(self, cursor: int | None = None, max_items: int = 500) -> ReadResult:
        """Entries from ``cursor``: ``None`` means "from now", negative means the last ``-cursor`` entries."""
        with self._lock:
            head, tail = self._next, self._tail()
            dropped, reset = None, False
            if cursor is None:
                cursor = head
            elif cursor < 0:
                cursor = max(tail, head + cursor)
            elif cursor > head:
                cursor, reset = tail, True
            elif cursor < tail:
                dropped, cursor = (cursor, tail), tail
            start = cursor - tail
            items = [entry for entry, _ in islice(self._items, start, start + max(0, max_items))]
            return ReadResult(items=items, next=cursor + len(items), head=head, tail=tail, dropped=dropped, reset=reset)

    def latest(self) -> dict[str, Any] | None:
        with self._lock:
            return self._items[-1][0] if self._items else None

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)
