from __future__ import annotations

import asyncio
import math
import time
from typing import TYPE_CHECKING

from teststand_backend.application.cancellation import AbortController, AbortError
from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.execution import parse_manual_tool_invocation_input
from teststand_backend.contracts.operations import operation
from teststand_backend.util import (
    utc_now_iso,
)

from .authorization import Authorizer, Json
from .execution import ExecutionCoordinator

if TYPE_CHECKING:
    from teststand_backend.devices import DeviceCatalogService, DeviceService

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

    @operation(
        "manual.invokeTool",
        capability="hardware.executeTools",
        risk="actuate",
    )
    async def invoke_tool(self, context: Json, raw: Json) -> Json:
        input = parse_manual_tool_invocation_input(raw)
        hardware = self.catalog.get_hardware(input["hardwareId"])
        if hardware["kind"] != "managed" or not hardware.get("deviceId"):
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
        if tool["deviceId"] != hardware["deviceId"]:
            raise app_error(
                "invalid_argument",
                f"Tool {input['toolName']} belongs to {tool['deviceId']}, "
                f"not hardware instance {hardware['deviceId']}",
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
        handle = self.execution.acquire(
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
                handle.release()

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
