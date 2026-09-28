"""Reserved hardware-lease interface (design doc 4.6); not wired into the server yet.

A future lease will let one owner (a test run, a canvas operator session)
hold exclusive write access to a device while streams stay readable by all.
Adapters must not depend on this module until the backend issues leases.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Lease:
    lease_id: str
    owner: str
    hardware_id: str
    expires_at: float


class LeaseProvider(Protocol):
    def check(self, hardware_id: str, lease_id: str | None) -> None:
        """Raise ``DeviceError(category="lease_conflict")`` when a write is not allowed."""
        ...


class NoLeases:
    """Current behaviour: every authenticated caller may write."""

    def check(self, hardware_id: str, lease_id: str | None) -> None:
        return None
