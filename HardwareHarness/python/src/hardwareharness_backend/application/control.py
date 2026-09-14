from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Callable
from datetime import UTC, datetime
from functools import cmp_to_key
from typing import TYPE_CHECKING

from hardwareharness_backend.compat import (
    clone,
    js_trim,
    new_uuid,
    now_ms,
    utc_now_iso,
    utf16_compare,
)
from hardwareharness_backend.compat.cancellation import AbortController, AbortError
from hardwareharness_backend.compat.collation import locale_compare
from hardwareharness_backend.compat.dates import date_ms
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.contracts.execution import parse_manual_tool_invocation_input
from hardwareharness_backend.contracts.occupancy import parse_request_hardware_occupancy_input

from .authorization import Authorizer, Json
from .execution import ExecutionCoordinator

if TYPE_CHECKING:
    from hardwareharness_backend.devices import DeviceCatalogService, DeviceService

JsonList = list[Json]


class ManualControlApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        devices: DeviceService,
        catalog: DeviceCatalogService,
        execution: ExecutionCoordinator,
    ) -> None:
        self.authorizer, self.devices, self.catalog, self.execution = (
            authorizer,
            devices,
            catalog,
            execution,
        )
        self.active: dict[asyncio.Task[Json], tuple[str, AbortController]] = {}

    async def invoke_tool(self, context: Json, raw: Json) -> Json:
        self.authorizer.authorize(context, "hardware.executeTools")
        input = parse_manual_tool_invocation_input(raw)
        hardware = self.catalog.get_hardware(input["hardwareId"])
        if hardware["kind"] != "managed" or not hardware.get("serverId"):
            raise app_error(
                "invalid_argument",
                f"Hardware {input['hardwareId']} is passive and cannot execute MCP tools",
            )
        tool = next(
            (
                item
                for item in self.devices.list_tools()
                if item["externalName"] == input["toolName"]
            ),
            None,
        )
        if tool is None:
            raise app_error("unavailable", f"MCP tool is unavailable: {input['toolName']}")
        if tool["serverId"] != hardware["serverId"]:
            raise app_error(
                "invalid_argument",
                f"Tool {input['toolName']} belongs to {tool['serverId']}, "
                f"not hardware server {hardware['serverId']}",
            )
        if tool["kind"] == "hardware":
            availability = next(
                (
                    item
                    for item in self.devices.list_availability()
                    if item["hardwareId"] == input["hardwareId"]
                ),
                None,
            )
            if not availability or availability["state"] != "available":
                state = availability["state"] if availability else "not yet checked"
                raise app_error(
                    "unavailable",
                    availability.get("message", f"Hardware {input['hardwareId']} is {state}")
                    if availability
                    else f"Hardware {input['hardwareId']} is {state}",
                )
        started_at, started = utc_now_iso(), time.perf_counter()
        lease = self.execution.acquire(
            {
                "state": "manual",
                "hardwareId": input["hardwareId"],
                "toolName": input["toolName"],
                "startedAt": started_at,
            }
        )
        controller = AbortController()

        async def invoke() -> Json:
            try:
                output = await self.devices.call_tool(
                    input["toolName"],
                    input["arguments"],
                    {
                        "timeoutMs": input["timeoutMs"],
                        "signal": controller.signal,
                        "metadata": {"hardwareId": input["hardwareId"]},
                    },
                )
                return {
                    "hardwareId": input["hardwareId"],
                    "toolName": input["toolName"],
                    "startedAt": started_at,
                    "completedAt": utc_now_iso(),
                    "durationMs": max(0, math.floor((time.perf_counter() - started) * 1000 + 0.5)),
                    "output": output,
                }
            finally:
                self.active.pop(completion, None)
                lease.release()

        completion = asyncio.create_task(invoke())
        self.active[completion] = (input["hardwareId"], controller)
        return await completion

    async def abort_hardware(self, hardware_id: str, message: str) -> None:
        calls = [
            (task, controller)
            for task, (key, controller) in self.active.items()
            if key == hardware_id
        ]
        for _, controller in calls:
            controller.abort(AbortError(message))
        await asyncio.gather(*(task for task, _ in calls), return_exceptions=True)

    async def close(self) -> None:
        calls = list(self.active.items())
        for _, (_, controller) in calls:
            controller.abort(AbortError("Application shutdown"))
        await asyncio.gather(*(task for task, _ in calls), return_exceptions=True)


class HardwareOccupancyApplication:
    def __init__(
        self, authorizer: Authorizer, devices: DeviceService, execution: ExecutionCoordinator
    ) -> None:
        self.authorizer, self.devices, self.execution = authorizer, devices, execution
        self.requests: dict[str, Json] = {}
        self.notifier: Callable[[Json], None] | None = None

    def set_notifier(self, notifier: Callable[[Json], None]) -> None:
        self.notifier = notifier

    def list(self, context: Json) -> JsonList:
        self.authorizer.authorize(context, "hardware.readOccupancy")
        return self.devices.occupancy.list()

    async def refresh(self, context: Json) -> JsonList:
        self.authorizer.authorize(context, "hardware.readOccupancy")
        return await self.devices.occupancy.refresh_all()

    async def acquire(self, context: Json, hardware_id: str) -> Json:
        self.authorizer.authorize(context, "hardware.manageOccupancy")
        return await self.devices.occupancy.acquire(hardware_id)

    async def release(self, context: Json, hardware_id: str) -> Json:
        self.authorizer.authorize(context, "hardware.manageOccupancy")
        if self.execution.is_hardware_busy(hardware_id):
            raise app_error(
                "conflict",
                f"Hardware {hardware_id} is currently executing; "
                "stop the manual call or Run before releasing it",
            )
        return await self.devices.occupancy.release(hardware_id)

    def request(self, context: Json, raw: Json) -> Json:
        self.authorizer.authorize(context, "hardware.requestOccupancy")
        input = parse_request_hardware_occupancy_input(raw)
        ids = sorted(set(input["hardwareIds"]), key=cmp_to_key(utf16_compare))
        managed = {
            server["hardwareId"] for server in self.devices.list_servers() if server["enabled"]
        }
        unknown = [hardware_id for hardware_id in ids if hardware_id not in managed]
        if unknown:
            raise app_error("invalid_argument", f"Unknown managed hardware: {', '.join(unknown)}")
        request: Json = {
            "occupancyRequestId": new_uuid(),
            "hardwareIds": ids,
            "status": "pending",
            "requestedAt": utc_now_iso(),
            "expiresAt": datetime.fromtimestamp((now_ms() + input["timeoutMs"]) / 1000, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "requestedBy": input.get(
                "requestedBy", "agent" if context["actor"] == "agent" else context["actor"]
            ),
        }
        if js_trim(input.get("reason", "")):
            request["reason"] = js_trim(input["reason"])
        self._save(request)
        return clone(request)

    def get_request(self, context: Json, request_id: str) -> Json:
        self.authorizer.authorize(context, "hardware.readOccupancy")
        return clone(self._expire(self._require_request(request_id)))

    def list_requests(self, context: Json, input: Json | None = None) -> JsonList:
        self.authorizer.authorize(context, "hardware.readOccupancy")
        query = input or {}
        for request in list(self.requests.values()):
            self._expire(request)
        requests = [
            request
            for request in self.requests.values()
            if query.get("status") is None or request["status"] == query["status"]
        ]
        requests.sort(
            key=cmp_to_key(lambda a, b: locale_compare(b["requestedAt"], a["requestedAt"]))
        )
        return clone(requests[: query.get("limit", 200)])

    async def acquire_request(self, context: Json, request_id: str) -> Json:
        self.authorizer.authorize(context, "hardware.manageOccupancy")
        request = self._require_pending(request_id)
        held = {
            hardware_id
            for hardware_id in request["hardwareIds"]
            if self.devices.occupancy.is_held(hardware_id)
        }
        acquired: list[str] = []
        try:
            for hardware_id in request["hardwareIds"]:
                if hardware_id not in held:
                    await self.devices.occupancy.acquire(hardware_id)
                    acquired.append(hardware_id)
        except Exception as error:
            await asyncio.gather(
                *(self.devices.occupancy.release(hardware_id) for hardware_id in acquired),
                return_exceptions=True,
            )
            pending = {**request, "message": f"Occupancy attempt failed: {error}"}
            self._save(pending)
            raise app_error("conflict", pending["message"], {"request": pending}) from error
        return self._finish(
            request,
            "confirmed",
            "All requested hardware is occupied by this HardwareHarness session",
        )

    def reject_request(self, context: Json, request_id: str, message: str | None = None) -> Json:
        self.authorizer.authorize(context, "hardware.manageOccupancy")
        return self._finish(self._require_pending(request_id), "rejected", message)

    def cancel_request(self, context: Json, request_id: str, message: str | None = None) -> Json:
        self.authorizer.authorize(context, "hardware.requestOccupancy")
        request = self._require_request(request_id)
        return (
            clone(request)
            if request["status"] != "pending"
            else self._finish(request, "cancelled", message)
        )

    def reconcile(self, statuses: JsonList) -> None:
        held = {
            status["hardwareId"] for status in statuses if status["state"] == "occupied_by_self"
        }
        for stored in list(self.requests.values()):
            request = self._expire(stored)
            if request["status"] == "pending" and all(
                key in held for key in request["hardwareIds"]
            ):
                self._finish(
                    request,
                    "confirmed",
                    "All requested hardware is occupied by this HardwareHarness session",
                )

    def _require_request(self, request_id: str) -> Json:
        if request_id not in self.requests:
            raise app_error("not_found", f"Unknown occupancy request: {request_id}")
        return self.requests[request_id]

    def _require_pending(self, request_id: str) -> Json:
        request = self._expire(self._require_request(request_id))
        if request["status"] != "pending":
            raise app_error("conflict", f"Occupancy request is {request['status']}, not pending")
        return request

    def _expire(self, request: Json) -> Json:
        if request["status"] != "pending" or date_ms(request["expiresAt"]) > now_ms():
            return request
        return self._finish(
            request, "timed_out", "Occupancy request expired before it was accepted"
        )

    def _finish(self, request: Json, status: str, message: str | None = None) -> Json:
        finished = {
            **request,
            "status": status,
            "completedAt": utc_now_iso(),
            **({"message": message} if message else {}),
        }
        self._save(finished)
        return clone(finished)

    def _save(self, request: Json) -> None:
        self.requests[request["occupancyRequestId"]] = request
        if self.notifier:
            self.notifier(clone(request))
