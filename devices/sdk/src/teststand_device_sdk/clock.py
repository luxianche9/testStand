"""Service clock: Unix-epoch milliseconds anchored once to a monotonic clock.

Every stream record, watermark and tool timing uses :func:`now_ms`, so times
never step backwards when the wall clock is adjusted while the service runs.
"""

from __future__ import annotations

import time

_WALL0_MS = time.time() * 1000.0
_MONO0 = time.perf_counter()


def now_ms() -> float:
    return round(_WALL0_MS + (time.perf_counter() - _MONO0) * 1000.0, 3)
