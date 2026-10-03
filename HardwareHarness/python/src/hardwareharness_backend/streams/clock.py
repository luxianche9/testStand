"""The one clock of the backend and its device plugins.

Every device runs in this process or in a child process on the same machine, and every record
``t``, watermark and backend time is the SDK's :func:`now_ms` (Unix milliseconds anchored to a
monotonic clock), so a device's time is the backend's time: offset and uncertainty are zero.
"""

from __future__ import annotations

from hardwareharness_device_sdk.clock import now_ms


def backend_ms() -> float:
    """Backend clock in Unix milliseconds: the SDK clock that stamps every record ``t``."""
    return now_ms()


class SharedClock:
    """A device clock as seen from the backend: the same clock."""

    known = True
    offset_ms = 0.0
    uncertainty_ms = 0.0

    def to_backend(self, device_ms: float) -> float:
        return device_ms

    def to_server(self, backend: float) -> float:
        return backend

    def snapshot(self) -> dict[str, float | None]:
        return {"offsetMs": 0.0, "uncertaintyMs": 0.0}


SHARED_CLOCK = SharedClock()
