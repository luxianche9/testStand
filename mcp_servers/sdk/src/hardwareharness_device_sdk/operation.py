"""Call correlation: the operation a tool call runs under.

The server puts one :class:`Operation` into a context variable per tool call.
``asyncio.to_thread`` copies the context, so the adapter's worker thread sees
the same object: every stream record appended during the call is tagged with
``op`` and its sequence range lands in ``stream_refs``. Records appended by
background threads (sampler, serial reader) carry no ``op``.
"""

from __future__ import annotations

import secrets
import threading
from contextvars import ContextVar
from typing import Any

from .clock import now_ms


class Operation:
    def __init__(self, operation_id: str | None = None) -> None:
        self.operation_id = operation_id or f"srv-{secrets.token_hex(6)}"
        self.start: float | None = None
        self.end: float | None = None
        self._refs: dict[str, list[int]] = {}
        self._lock = threading.Lock()

    def record(self, stream_id: str, seq: int) -> None:
        with self._lock:
            span = self._refs.get(stream_id)
            if span is None:
                self._refs[stream_id] = [seq, seq]
            else:
                span[0], span[1] = min(span[0], seq), max(span[1], seq)

    def begin(self) -> None:
        if self.start is None:
            self.start = now_ms()

    def finish(self) -> None:
        self.end = now_ms()

    def stream_refs(self) -> list[dict[str, Any]]:
        with self._lock:
            return [{"streamId": key, "fromSeq": span[0], "toSeq": span[1]} for key, span in self._refs.items()]

    def meta(self) -> dict[str, Any]:
        result: dict[str, Any] = {"operationId": self.operation_id, "streamRefs": self.stream_refs()}
        if self.start is not None:
            result["timing"] = {"start": self.start, "end": self.end if self.end is not None else now_ms()}
        return result


CURRENT: ContextVar[Operation | None] = ContextVar("hardwareharness_operation", default=None)


def current() -> Operation | None:
    return CURRENT.get()
