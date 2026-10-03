"""Thread-safe, sequence-numbered ring buffer with a watermark, backing every stream."""

from __future__ import annotations

import secrets
import threading
from collections import deque
from dataclasses import dataclass
from itertools import islice
from typing import Any

from .clock import now_ms

T_EPSILON = 0.001
"""Records get strictly increasing ``t``: at least this many ms after the previous record or watermark."""


@dataclass(frozen=True)
class ReadResult:
    records: list[dict[str, Any]]
    next: int
    head: int
    tail: int
    watermark: float
    dropped: tuple[int, int] | None = None
    """``(fromSeq, toSeq)`` range evicted before the reader got to it."""
    reset: bool = False
    """The cursor belonged to another epoch or was ahead of ``head``; reading restarted at ``tail``."""


class RingBuffer:
    """Records are ``{"seq", "t", **fields}``; ``seq`` increases from 0 and ``t`` strictly increases.

    ``tail`` is the oldest retained sequence and ``head`` the next one to be
    assigned. Readers hold cursors (sequence numbers), so any number of them
    share one buffer. Eviction happens by record count and optionally by
    summed ``weight`` (bytes).

    The watermark promises that no record with ``t <= watermark`` will be
    appended later. A *clocked* buffer (event streams: bytes, frames, pushed
    values) is complete up to "now", so its watermark is the current time.
    A sampled buffer only knows the time of its last sample attempt, which
    the sampler reports through :meth:`advance`.
    """

    def __init__(self, capacity: int = 4096, *, max_weight: int | None = None, clocked: bool = True) -> None:
        if capacity < 1:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self.max_weight = max_weight
        self.clocked = clocked
        self.epoch = secrets.token_hex(4)
        self._items: deque[tuple[dict[str, Any], int]] = deque()
        self._weight = 0
        self._next = 0
        self._floor = 0.0
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

    def _watermark(self) -> float:
        if self.clocked:
            self._floor = max(self._floor, now_ms())
        return self._floor

    def watermark(self) -> float:
        with self._lock:
            return self._watermark()

    def advance(self, t: float) -> None:
        """Declare that no record with ``t`` at or before this time will follow (sample attempt finished)."""
        with self._lock:
            self._floor = max(self._floor, round(t, 3))

    def append(self, fields: dict[str, Any], *, weight: int = 0, t: float | None = None) -> dict[str, Any]:
        with self._lock:
            stamp = now_ms() if t is None else round(t, 3)
            if stamp <= self._floor:
                stamp = round(self._floor + T_EPSILON, 3)
            self._floor = stamp
            entry = {"seq": self._next, "t": stamp, **fields}
            self._next += 1
            self._items.append((entry, weight))
            self._weight += weight
            while len(self._items) > self.capacity or (
                self.max_weight is not None and self._weight > self.max_weight and len(self._items) > 1
            ):
                _, evicted = self._items.popleft()
                self._weight -= evicted
            return entry

    def read(self, cursor: int | None = None, max_items: int = 500, *, epoch: str | None = None) -> ReadResult:
        """Records from ``cursor``: ``None`` = from now on, negative = the last ``-cursor`` records.

        ``epoch`` is the epoch the cursor came from; a different epoch restarts at ``tail`` with ``reset``.
        """
        with self._lock:
            head, tail = self._next, self._tail()
            dropped, reset = None, False
            if cursor is None:
                cursor = head
            elif cursor < 0:
                cursor = max(tail, head + cursor)
            elif (epoch is not None and epoch != self.epoch) or cursor > head:
                cursor, reset = tail, True
            elif cursor < tail:
                dropped, cursor = (cursor, tail - 1), tail
            start = cursor - tail
            records = [entry for entry, _ in islice(self._items, start, start + max(0, max_items))]
            nxt = cursor + len(records)
            # A reader that has not caught up with head is only complete up to just before its next record.
            watermark = (self._watermark() if nxt == head
                         else round(self._items[nxt - tail][0]["t"] - T_EPSILON, 3))
            return ReadResult(records=records, next=nxt, head=head, tail=tail, watermark=watermark,
                              dropped=dropped, reset=reset)

    def seek(self, t: float, *, hold: bool = False) -> int:
        """Sequence of the first retained record with ``t`` at or after ``t``, else ``head``.

        ``hold`` starts one record earlier when one exists: the level still in force at ``t``.
        """
        with self._lock:
            held: int | None = None
            for entry, _ in self._items:
                if entry["t"] >= t:
                    return held if hold and held is not None and entry["t"] > t else int(entry["seq"])
                held = int(entry["seq"])
            return held if hold and held is not None else self._next

    def latest(self) -> dict[str, Any] | None:
        with self._lock:
            return self._items[-1][0] if self._items else None

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)
