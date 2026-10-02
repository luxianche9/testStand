"""Per-service clock offset estimate (NTP style, minimum round trip over a sliding window).

``offset = serverTime - backendTime``. A sample is taken from a request sent at
backend time ``send`` and answered at ``recv`` carrying ``serverTime``; the
server stamped it somewhere inside ``[send, recv]``, so the offset is
``serverTime - (send + recv) / 2`` with uncertainty ``(recv - send) / 2``.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass

WINDOW = 16


def backend_ms() -> float:
    """Backend wall clock in fractional milliseconds (same epoch as the SDK ``t``)."""
    return time.time_ns() / 1_000_000


@dataclass(frozen=True)
class ClockSample:
    offset_ms: float
    uncertainty_ms: float
    at_ms: float


class ClockEstimator:
    def __init__(self, window: int = WINDOW) -> None:
        self._samples: deque[ClockSample] = deque(maxlen=window)
        self._best: ClockSample | None = None

    def add(self, send_ms: float, server_ms: float, recv_ms: float) -> None:
        if recv_ms < send_ms:
            return
        sample = ClockSample(
            offset_ms=server_ms - (send_ms + recv_ms) / 2,
            uncertainty_ms=(recv_ms - send_ms) / 2,
            at_ms=recv_ms,
        )
        self._samples.append(sample)
        self._best = min(self._samples, key=lambda item: item.uncertainty_ms)

    @property
    def known(self) -> bool:
        return self._best is not None

    @property
    def offset_ms(self) -> float:
        return self._best.offset_ms if self._best else 0.0

    @property
    def uncertainty_ms(self) -> float:
        return self._best.uncertainty_ms if self._best else float("inf")

    def to_backend(self, server_ms: float) -> float:
        return server_ms - self.offset_ms

    def to_server(self, backend: float) -> float:
        return backend + self.offset_ms

    def snapshot(self) -> dict[str, float | None]:
        if self._best is None:
            return {"offsetMs": None, "uncertaintyMs": None}
        return {
            "offsetMs": round(self._best.offset_ms, 3),
            "uncertaintyMs": round(self._best.uncertainty_ms, 3),
        }
