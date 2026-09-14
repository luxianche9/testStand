from __future__ import annotations

import asyncio
import builtins
import math
import socket
from collections.abc import Callable
from datetime import datetime
from typing import Any

from hardwareharness_backend.compat import clone, js_string, new_uuid, now_ms, utc_now_iso
from hardwareharness_backend.contracts.errors import app_error

Record = dict[str, Any]


def _expiry(value: Any) -> float:
    try:
        if not isinstance(value, str):
            return math.nan
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except (ValueError, OverflowError, OSError):
        return math.nan


class HardwareOccupancyManager:
    def __init__(self, store: Any, transports: Any) -> None:
        self.store, self.transports = store, transports
        self.holder_id = new_uuid()
        self.holder_label = f"HardwareHarness@{socket.gethostname()}"
        self.active: dict[str, Record] = {}
        self.statuses: dict[str, Record] = {}
        self._timer: asyncio.Task[None] | None = None
        self._notifier: Callable[[list[Record]], None] | None = None
        self._lost_notifier: Callable[[str, str], None] | None = None

    def set_notifier(self, notifier: Callable[[list[Record]], None]) -> None:
        self._notifier = notifier

    def set_lost_notifier(self, notifier: Callable[[str, str], None]) -> None:
        self._lost_notifier = notifier

    def list(self) -> list[Record]:
        return [
            clone(
                self.statuses.get(
                    server["hardwareId"], {"hardwareId": server["hardwareId"], "state": "unknown"}
                )
            )
            for server in self.store.list_servers()
        ]

    def is_held(self, hardware_id: str) -> bool:
        lease = self.active.get(hardware_id)
        return bool(lease and _expiry(lease["expiresAt"]) > now_ms())

    def require_lease(self, hardware_id: str) -> str:
        lease = self.active.get(hardware_id)
        if (
            not lease
            or not math.isfinite(_expiry(lease["expiresAt"]))
            or _expiry(lease["expiresAt"]) <= now_ms()
        ):
            if lease:
                self._mark_lost(hardware_id, "Hardware occupancy lease expired")
            raise app_error(
                "occupancy_required",
                f"Hardware {hardware_id} must be occupied by a human before it can be operated",
            )
        return str(lease["leaseId"])

    async def refresh(self, hardware_id: str) -> Record:
        server = self._server_for_hardware(hardware_id)
        try:
            remote = await self.transports.call_internal(
                server,
                "hardwareharness_hardware_occupancy",
                {"hardwareId": hardware_id, "action": "status"},
            )
            status = self._to_status(hardware_id, remote)
            self.statuses[hardware_id] = status
            if hardware_id in self.active and status["state"] != "occupied_by_self":
                self._mark_lost(
                    hardware_id,
                    "Remote hardware lease is no longer owned by this HardwareHarness session",
                )
            self._emit()
            return clone(self.statuses.get(hardware_id, status))
        except Exception as error:
            status = {"hardwareId": hardware_id, "state": "unknown", "message": js_string(error)}
            self.statuses[hardware_id] = status
            self._emit()
            return clone(status)

    async def refresh_all(self) -> builtins.list[Record]:
        await asyncio.gather(
            *(
                self.refresh(server["hardwareId"])
                for server in self.store.list_servers()
                if server["enabled"]
            ),
            return_exceptions=True,
        )
        return self.list()

    async def acquire(self, hardware_id: str) -> Record:
        if self.is_held(hardware_id):
            return self._current(hardware_id)
        server = self._server_for_hardware(hardware_id)
        lease_id = new_uuid()
        remote = await self.transports.call_internal(
            server,
            "hardwareharness_hardware_occupancy",
            {
                "hardwareId": hardware_id,
                "action": "acquire",
                "holderId": self.holder_id,
                "holderLabel": self.holder_label,
                "leaseId": lease_id,
            },
        )
        if not self._valid_ownership(remote):
            raise app_error("conflict", f"Hardware {hardware_id} could not be occupied", remote)
        self.active[hardware_id] = {
            "hardwareId": hardware_id,
            "leaseId": lease_id,
            "acquiredAt": remote.get("acquiredAt") or utc_now_iso(),
            "expiresAt": remote["expiresAt"],
        }
        self.statuses[hardware_id] = self._to_status(hardware_id, remote)
        if not self._timer:
            self._timer = asyncio.create_task(self._heartbeat_loop())
        self._emit()
        return self._current(hardware_id)

    async def release(self, hardware_id: str) -> Record:
        lease = self.active.get(hardware_id)
        if not lease:
            return await self.refresh(hardware_id)
        server = self._server_for_hardware(hardware_id)
        remote = await self.transports.call_internal(
            server,
            "hardwareharness_hardware_occupancy",
            {
                "hardwareId": hardware_id,
                "action": "release",
                "holderId": self.holder_id,
                "leaseId": lease["leaseId"],
            },
        )
        self.active.pop(hardware_id, None)
        self.statuses[hardware_id] = self._to_status(hardware_id, remote)
        self._stop_timer_if_idle()
        self._emit()
        return self._current(hardware_id)

    async def close(self) -> None:
        timer, self._timer = self._timer, None
        if timer:
            timer.cancel()
            await asyncio.gather(timer, return_exceptions=True)
        await asyncio.gather(
            *(self.release(hardware_id) for hardware_id in list(self.active)),
            return_exceptions=True,
        )
        self.active.clear()

    async def heartbeat(self) -> None:
        for lease in list(self.active.values()):
            hardware_id = lease["hardwareId"]
            try:
                server = self._server_for_hardware(hardware_id)
                remote = await self.transports.call_internal(
                    server,
                    "hardwareharness_hardware_occupancy",
                    {
                        "hardwareId": hardware_id,
                        "action": "heartbeat",
                        "holderId": self.holder_id,
                        "leaseId": lease["leaseId"],
                    },
                )
                if not self._valid_ownership(remote):
                    self._mark_lost(hardware_id, "Hardware occupancy heartbeat was rejected")
                    continue
                lease["expiresAt"] = remote["expiresAt"]
                self.statuses[hardware_id] = self._to_status(hardware_id, remote)
                self._emit()
            except Exception as error:
                if _expiry(lease["expiresAt"]) <= now_ms():
                    self._mark_lost(
                        hardware_id, f"Hardware occupancy heartbeat expired: {js_string(error)}"
                    )

    async def _heartbeat_loop(self) -> None:
        while self.active:
            await asyncio.sleep(5)
            await self.heartbeat()

    def _valid_ownership(self, remote: Record) -> bool:
        # Approved TS exception: Date.parse(NaN) must not allow an invalid lease forever.
        return (
            remote.get("state") == "occupied"
            and remote.get("holderId") == self.holder_id
            and bool(remote.get("expiresAt"))
            and math.isfinite(_expiry(remote.get("expiresAt")))
        )

    def _to_status(self, hardware_id: str, remote: Record) -> Record:
        if remote.get("state") != "occupied":
            return {"hardwareId": hardware_id, "state": "unoccupied"}
        return {
            "hardwareId": hardware_id,
            "state": "occupied_by_self"
            if remote.get("holderId") == self.holder_id
            else "occupied_elsewhere",
            **{
                key: remote[key]
                for key in ["holderLabel", "acquiredAt", "expiresAt"]
                if remote.get(key)
            },
        }

    def _current(self, hardware_id: str) -> Record:
        return clone(
            self.statuses.get(hardware_id, {"hardwareId": hardware_id, "state": "unknown"})
        )

    def _server_for_hardware(self, hardware_id: str) -> Any:
        server = next(
            (
                item
                for item in self.store.list_servers()
                if item["hardwareId"] == hardware_id and item["enabled"]
            ),
            None,
        )
        if not server:
            raise app_error(
                "not_found", f"No enabled MCP server is registered for hardware {hardware_id}"
            )
        return server

    def _mark_lost(self, hardware_id: str, message: str) -> None:
        if self.active.pop(hardware_id, None) is None:
            return
        self.statuses[hardware_id] = {
            "hardwareId": hardware_id,
            "state": "unknown",
            "message": message,
        }
        self._stop_timer_if_idle()
        self._emit()
        if self._lost_notifier:
            self._lost_notifier(hardware_id, message)

    def _stop_timer_if_idle(self) -> None:
        if not self.active and self._timer:
            if self._timer is not asyncio.current_task():
                self._timer.cancel()
            self._timer = None

    def _emit(self) -> None:
        if self._notifier:
            self._notifier(self.list())
