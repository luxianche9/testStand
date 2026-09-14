from __future__ import annotations

import base64
import inspect
import os
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

from testforge_backend.compat import clone, json_parse
from testforge_backend.contracts.devices import hardware_schema
from testforge_backend.contracts.errors import app_error
from testforge_backend.contracts.occupancy import (
    occupancy_request_list_query_schema,
    request_hardware_occupancy_input_schema,
)
from testforge_backend.contracts.orchestration import test_task_schema
from testforge_backend.contracts.validation import (
    Schema,
    array,
    custom_issue,
    number,
    obj,
    parse_record,
    record,
    string,
    unknown,
)
from testforge_backend.contracts.wiring import (
    pin_pair_schema,
    wiring_action_schema,
    wiring_task_status_schema,
)

Record = dict[str, Any]
UPDATE_TEST_TASK_INPUT_SCHEMA: Record = json_parse(
    files(__package__).joinpath("workflow_schema.json").read_text(encoding="utf-8")
)


_EMPTY = obj({}, strict=True)
_COMPUTER_ID = obj({"computerId": string(1)}, strict=True)
_SERVER_ID = obj({"serverId": string(1)}, strict=True)
_HARDWARE_ID = obj({"hardwareId": string(1)}, strict=True)
_WIRING_TASK_ID = obj({"wiringTaskId": string(1)}, strict=True)
_OCCUPANCY_REQUEST_ID = obj({"occupancyRequestId": string(1)}, strict=True)
_ARGUMENT_SCHEMAS: dict[str, Schema] = {
    "get_project": _EMPTY,
    "save_project": _EMPTY,
    "initialize_project": obj(
        {
            "rootPath": string(1).refine(
                lambda value: (
                    [] if os.path.isabs(value) else [custom_issue("rootPath must be absolute")]
                )
            )
        },
        strict=True,
    ),
    "open_project": obj(
        {
            "rootPath": string(1).refine(
                lambda value: (
                    [] if os.path.isabs(value) else [custom_issue("rootPath must be absolute")]
                )
            )
        },
        strict=True,
    ),
    "list_remote_computers": _EMPTY,
    "get_remote_computer_status": _COMPUTER_ID,
    "list_mcp_servers": _EMPTY,
    "get_remote_mcp_service": _SERVER_ID,
    "start_remote_mcp_service": _SERVER_ID,
    "stop_remote_mcp_service": _SERVER_ID,
    "restart_remote_mcp_service": _SERVER_ID,
    "read_remote_mcp_logs": obj(
        {"serverId": string(1), "lines": number(1, 2000, integer=True).default(200)}, strict=True
    ),
    "list_managed_hardware": _EMPTY,
    "list_hardware_catalog": _EMPTY,
    "get_hardware_definition": _HARDWARE_ID,
    "save_hardware_definition": obj({"hardware": hardware_schema}, strict=True),
    "remove_hardware_definition": _HARDWARE_ID,
    "set_hardware_image": obj(
        {
            "hardwareId": string(1),
            "portId": string(1).optional(),
            "imageBase64": string(1),
            "fileName": string().default(""),
        },
        strict=True,
    ),
    "remove_hardware_image": obj(
        {"hardwareId": string(1), "portId": string(1).optional()}, strict=True
    ),
    "request_hardware_occupancy": request_hardware_occupancy_input_schema,
    "cancel_hardware_occupancy_request": obj(
        {"occupancyRequestId": string(1), "message": string().optional()}, strict=True
    ),
    "get_hardware_occupancy_request": _OCCUPANCY_REQUEST_ID,
    "list_hardware_occupancy_requests": occupancy_request_list_query_schema,
    "add_managed_hardware_to_canvas": _HARDWARE_ID,
    "request_wiring_task": obj(
        {
            "portA": string(1),
            "portB": string(1),
            "pins": array(pin_pair_schema).default([]),
            "action": wiring_action_schema,
            "timeoutMs": number(1000, 86_400_000, integer=True).default(1_800_000),
        },
        strict=True,
    ),
    "cancel_wiring_task": obj(
        {"wiringTaskId": string(1), "message": string().optional()}, strict=True
    ),
    "get_wiring_task": _WIRING_TASK_ID,
    "list_wiring_tasks": obj(
        {
            "status": wiring_task_status_schema.optional(),
            "limit": number(1, 500, integer=True).default(100),
        },
        strict=True,
    ),
    "get_test_task": _EMPTY,
    "update_test_task": obj({"task": test_task_schema}, strict=True),
    "start_test_run": obj({"inputs": record(unknown()).default({})}, strict=True),
    "cancel_test_run": obj({"runId": string(1)}, strict=True),
    "get_test_run": obj(
        {
            "runId": string(1),
            "sinceEventId": number(0, integer=True).default(0),
            "nodeOffset": number(0, integer=True).default(0),
            "nodeLimit": number(1, 1000, integer=True).default(200),
        },
        strict=True,
    ),
}


@dataclass
class GatewayToolDefinition:
    tool: Record
    capability: str

    def parse(self, value: Any) -> Record:
        return parse_record(_ARGUMENT_SCHEMAS[self.tool["name"]], value)

    async def execute(self, application: Any, context: Record, value: Record) -> Record:
        handler, arguments = _handler_arguments(application, context, self.tool["name"], value)
        data = handler(*arguments)
        if inspect.isawaitable(data):
            data = await data
        if self.tool["name"] == "update_test_task":
            data = {"task": data["task"], "dirty": data["dirty"]}
        return {"ok": True, "data": data}


BUILTIN_TOOL_DEFINITIONS = [
    GatewayToolDefinition(item["tool"], item["capability"])
    for resource in ("project_tools.json", "builtin_tools.json")
    for item in json_parse(files(__package__).joinpath(resource).read_text("utf-8"))
]


class ToolRegistry:
    def __init__(
        self, application: Any, definitions: list[GatewayToolDefinition] | None = None
    ) -> None:
        self.application = application
        self._builtin: dict[str, GatewayToolDefinition] = {}
        for definition in BUILTIN_TOOL_DEFINITIONS if definitions is None else definitions:
            name = definition.tool["name"]
            if name in self._builtin:
                raise RuntimeError(f"Duplicate builtin MCP tool name: {name}")
            self._builtin[name] = definition

    def list_builtin(self, context: Record) -> list[Record]:
        return [
            clone(definition.tool)
            for definition in self._builtin.values()
            if self.application.authorizer.is_allowed(context, definition.capability)
        ]

    def list(self, context: Record) -> list[Record]:
        output = self.list_builtin(context)
        if self.application.authorizer.is_allowed(context, "hardware.executeTools"):
            output += [
                {
                    "name": tool["externalName"],
                    "inputSchema": clone(tool["inputSchema"]),
                    **({"description": tool["description"]} if "description" in tool else {}),
                }
                for tool in self.application.devices.list_tools(context)
            ]
        names = set()
        for tool in output:
            if tool["name"] in names:
                raise app_error("conflict", f"Duplicate MCP tool name: {tool['name']}")
            names.add(tool["name"])
        return output

    async def invoke(self, context: Record, name: str, args: Record) -> Record:
        builtin = self._builtin.get(name)
        if builtin:
            self.application.authorizer.authorize(context, builtin.capability)
            return await builtin.execute(self.application, context, builtin.parse(args))
        self.application.authorizer.authorize(context, "hardware.executeTools")
        remote = next(
            (
                tool
                for tool in self.application.devices.list_tools(context)
                if tool["externalName"] == name
            ),
            None,
        )
        if not remote:
            raise app_error("not_found", f"Unknown MCP tool: {name}")
        return {"ok": True, "data": await self.application.devices.call_tool(context, name, args)}


def _handler_arguments(
    app: Any, context: Record, name: str, value: Record
) -> tuple[Any, list[Any]]:
    if name in {"get_project", "save_project", "initialize_project", "open_project"}:
        if name in {"initialize_project", "open_project"}:
            if app.system.dashboard(context)["execution"]["state"] != "idle":
                raise app_error("conflict", "Finish the active execution before switching projects")
            if (app.projects.document(context) or {}).get("dirty"):
                raise app_error("conflict", "Save the current project before switching projects")
            handler = (
                app.projects.initialize_folder
                if name == "initialize_project"
                else app.projects.open_folder
            )
            return handler, [context, value["rootPath"]]
        return (app.projects.document if name == "get_project" else app.projects.save_project), [
            context
        ]
    devices, wiring, occupancy, orchestration = (
        app.devices,
        app.wiring,
        app.occupancy,
        app.orchestration,
    )
    mapping: dict[str, tuple[Any, list[Any]]] = {
        "list_remote_computers": (devices.list_computers, []),
        "get_remote_computer_status": (devices.get_computer_status, [value.get("computerId")]),
        "list_mcp_servers": (devices.list_servers_with_status, []),
        "get_remote_mcp_service": (devices.refresh_server, [value.get("serverId")]),
        "read_remote_mcp_logs": (
            devices.read_server_logs,
            [value.get("serverId"), value.get("lines")],
        ),
        "list_managed_hardware": (devices.list_managed_hardware, []),
        "list_hardware_catalog": (devices.list_hardware, []),
        "get_hardware_definition": (devices.get_hardware, [value.get("hardwareId")]),
        "save_hardware_definition": (devices.save_hardware, [value.get("hardware")]),
        "remove_hardware_definition": (devices.remove_hardware, [value.get("hardwareId")]),
        "remove_hardware_image": (
            devices.remove_hardware_image,
            [value.get("hardwareId"), value.get("portId")],
        ),
        "request_hardware_occupancy": (occupancy.request, [value]),
        "cancel_hardware_occupancy_request": (
            occupancy.cancel_request,
            [value.get("occupancyRequestId"), value.get("message")],
        ),
        "get_hardware_occupancy_request": (
            occupancy.get_request,
            [value.get("occupancyRequestId")],
        ),
        "list_hardware_occupancy_requests": (occupancy.list_requests, [value]),
        "add_managed_hardware_to_canvas": (
            wiring.add_managed_hardware_to_canvas,
            [value.get("hardwareId")],
        ),
        "request_wiring_task": (wiring.request_task, [value]),
        "cancel_wiring_task": (
            wiring.cancel_task,
            [value.get("wiringTaskId"), value.get("message")],
        ),
        "get_wiring_task": (wiring.get_task, [value.get("wiringTaskId")]),
        "list_wiring_tasks": (wiring.list_tasks, [value]),
        "get_test_task": (orchestration.get_task, []),
        "update_test_task": (orchestration.update_task, [value.get("task")]),
        "start_test_run": (orchestration.start_run, [{"inputs": value.get("inputs", {})}]),
        "cancel_test_run": (orchestration.cancel_run, [value.get("runId")]),
        "get_test_run": (
            orchestration.get_run,
            [
                value.get("runId"),
                value.get("sinceEventId"),
                value.get("nodeOffset"),
                value.get("nodeLimit"),
            ],
        ),
    }
    if name in {
        "start_remote_mcp_service",
        "stop_remote_mcp_service",
        "restart_remote_mcp_service",
    }:
        return devices.server_action, [context, value["serverId"], name.split("_")[0]]
    if name == "set_hardware_image":
        return devices.set_hardware_image_bytes, [
            context,
            value["hardwareId"],
            value.get("portId"),
            _decode_image(value["imageBase64"]),
            value["fileName"],
        ]
    handler, args = mapping[name]
    return handler, [context, *args]


def _decode_image(value: str) -> bytes:
    trimmed = value.strip()
    payload = trimmed[trimmed.find(",") + 1 :] if trimmed.startswith("data:") else trimmed
    if not payload:
        raise app_error("invalid_argument", "imageBase64 is required")
    # Buffer.from(base64) accepts whitespace, URL alphabet and missing padding.
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_"
    filtered = "".join(character for character in payload.split("=")[0] if character in alphabet)
    filtered = filtered[: len(filtered) - (1 if len(filtered) % 4 == 1 else 0)]
    result = base64.b64decode(filtered + "=" * (-len(filtered) % 4), altchars=b"-_")
    if not result:
        raise app_error("invalid_argument", "imageBase64 is not valid base64")
    return result
