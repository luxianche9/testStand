from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from testforge_remote.adapters import AdapterError


LEASE_TTL_SECONDS = 15.0


@dataclass
class Lease:
    holder_id: str
    holder_label: str
    lease_id: str
    acquired_at: datetime
    expires_at: datetime
    deadline: float


class OccupancyRegistry:
    def __init__(self, ttl_seconds: float = LEASE_TTL_SECONDS) -> None:
        self.ttl_seconds = ttl_seconds
        self.leases: dict[str, Lease] = {}

    async def action_locked(self, runtime: Any, action: str, holder_id: str | None = None,
                            holder_label: str | None = None, lease_id: str | None = None) -> dict[str, Any]:
        await self.expire_locked(runtime)
        hardware_id = runtime.adapter.hardware_id
        if action == "status":
            return self.status_locked(hardware_id)
        if action == "acquire":
            if not holder_id or not holder_label or not lease_id:
                raise AdapterError("acquire requires holderId, holderLabel and leaseId", category="invalid_argument")
            current = self.leases.get(hardware_id)
            if current:
                if current.holder_id == holder_id and current.lease_id == lease_id:
                    self._renew(current)
                    return self.status_locked(hardware_id)
                raise AdapterError(f"Hardware {hardware_id} is already occupied by {current.holder_label}", category="conflict")
            now = datetime.now(UTC)
            self.leases[hardware_id] = Lease(holder_id, holder_label, lease_id, now,
                                              now + timedelta(seconds=self.ttl_seconds),
                                              time.monotonic() + self.ttl_seconds)
            return self.status_locked(hardware_id)
        if action == "heartbeat":
            current = self.leases.get(hardware_id)
            if current and current.holder_id == holder_id and current.lease_id == lease_id:
                self._renew(current)
            return self.status_locked(hardware_id)
        if action == "release":
            current = self.leases.get(hardware_id)
            if current and current.holder_id == holder_id and current.lease_id == lease_id:
                await self.safe_and_clear_locked(runtime)
            return self.status_locked(hardware_id)
        raise AdapterError(f"Unknown occupancy action: {action}", category="invalid_argument")

    async def require_locked(self, runtime: Any, lease_id: str | None) -> None:
        await self.expire_locked(runtime)
        current = self.leases.get(runtime.adapter.hardware_id)
        if current is None or not lease_id or current.lease_id != lease_id:
            raise AdapterError(f"Hardware {runtime.adapter.hardware_id} requires a current occupancy lease", category="occupancy_required")

    async def expire_locked(self, runtime: Any) -> bool:
        hardware_id = runtime.adapter.hardware_id
        current = self.leases.get(hardware_id)
        if current is None or current.deadline > time.monotonic():
            return False
        await self.safe_and_clear_locked(runtime)
        return True

    async def safe_and_clear_locked(self, runtime: Any) -> None:
        try:
            await runtime.adapter.safe()
        finally:
            self.leases.pop(runtime.adapter.hardware_id, None)

    def clear_locked(self, hardware_id: str) -> None:
        self.leases.pop(hardware_id, None)

    def status_locked(self, hardware_id: str) -> dict[str, Any]:
        current = self.leases.get(hardware_id)
        if current is None:
            return {"state": "unoccupied"}
        return {
            "state": "occupied",
            "holderId": current.holder_id,
            "holderLabel": current.holder_label,
            "acquiredAt": current.acquired_at.isoformat(),
            "expiresAt": current.expires_at.isoformat(),
        }

    def _renew(self, lease: Lease) -> None:
        lease.expires_at = datetime.now(UTC) + timedelta(seconds=self.ttl_seconds)
        lease.deadline = time.monotonic() + self.ttl_seconds

