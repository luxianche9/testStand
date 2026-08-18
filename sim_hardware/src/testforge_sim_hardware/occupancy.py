from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Event, RLock, Thread
from typing import Any, Callable


@dataclass
class Lease:
    holder_id: str
    holder_label: str
    lease_id: str
    acquired_at: datetime
    expires_at: datetime


class HardwareOccupancy:
    def __init__(self, hardware_id: str, safe: Callable[[], Any], lock: RLock, ttl_seconds: float = 15.0) -> None:
        self.hardware_id = hardware_id
        self._safe = safe
        self._lock = lock
        self._ttl = timedelta(seconds=ttl_seconds)
        self._lease: Lease | None = None
        self._stop = Event()
        self._thread: Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(target=self._watch, name=f"occupancy-{self.hardware_id}", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        with self._lock:
            if self._lease is not None:
                self._safe_and_clear_locked()

    def action(self, hardware_id: str, action: str, holder_id: str | None = None,
               holder_label: str | None = None, lease_id: str | None = None) -> dict[str, Any]:
        if hardware_id != self.hardware_id:
            raise occupancy_error("invalid_argument", f"Unknown hardwareId: {hardware_id}")
        with self._lock:
            self._expire_locked()
            if action == "status":
                return self._status_locked()
            if action == "acquire":
                if not holder_id or not holder_label or not lease_id:
                    raise occupancy_error("invalid_argument", "acquire requires holderId, holderLabel and leaseId")
                if self._lease is not None:
                    if self._lease.holder_id == holder_id and self._lease.lease_id == lease_id:
                        self._lease.expires_at = self._now() + self._ttl
                        return self._status_locked()
                    raise occupancy_error("conflict", f"Hardware {hardware_id} is already occupied by {self._lease.holder_label}")
                now = self._now()
                self._lease = Lease(holder_id, holder_label, lease_id, now, now + self._ttl)
                return self._status_locked()
            if action == "heartbeat":
                if self._matches(holder_id, lease_id):
                    self._lease.expires_at = self._now() + self._ttl  # type: ignore[union-attr]
                return self._status_locked()
            if action == "release":
                if self._matches(holder_id, lease_id):
                    self._safe_and_clear_locked()
                return self._status_locked()
            raise occupancy_error("invalid_argument", f"Unknown occupancy action: {action}")

    def require(self, lease_id: str | None) -> None:
        self._expire_locked()
        if self._lease is None or not lease_id or self._lease.lease_id != lease_id:
            raise occupancy_error("occupancy_required", f"Hardware {self.hardware_id} requires a current occupancy lease")

    def _watch(self) -> None:
        while not self._stop.wait(0.5):
            with self._lock:
                self._expire_locked()

    def _expire_locked(self) -> None:
        if self._lease is not None and self._lease.expires_at <= self._now():
            self._safe_and_clear_locked()

    def _safe_and_clear_locked(self) -> None:
        try:
            self._safe()
        finally:
            self._lease = None

    def _matches(self, holder_id: str | None, lease_id: str | None) -> bool:
        return bool(self._lease and holder_id and lease_id and self._lease.holder_id == holder_id and self._lease.lease_id == lease_id)

    def _status_locked(self) -> dict[str, Any]:
        if self._lease is None:
            return {"state": "unoccupied"}
        return {
            "state": "occupied",
            "holderId": self._lease.holder_id,
            "holderLabel": self._lease.holder_label,
            "acquiredAt": self._lease.acquired_at.isoformat(),
            "expiresAt": self._lease.expires_at.isoformat(),
        }

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)


def occupancy_error(category: str, message: str) -> Exception:
    error = RuntimeError(message)
    setattr(error, "category", category)
    return error
