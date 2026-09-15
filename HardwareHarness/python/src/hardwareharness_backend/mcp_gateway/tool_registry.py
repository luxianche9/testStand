from __future__ import annotations

import base64
import hashlib
import inspect
import os
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

from hardwareharness_backend.compat import clone, json_parse
from hardwareharness_backend.contracts.devices import hardware_schema
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.contracts.validation import (
    Schema,
    array,
    boolean,
    custom_issue,
    enum,
    number,
    obj,
    parse_record,
    record,
    string,
    union,
    unknown,
)
from hardwareharness_backend.contracts.wiring import (
    pin_pair_schema,
    wiring_action_schema,
    wiring_task_status_schema,
)

from .agent_services import AGENT_ARGUMENT_SCHEMAS, AGENT_TOOL_DEFINITIONS, invoke_agent_tool
from .contract_tools import (
    CONTRACT_ARGUMENT_SCHEMAS,
    CONTRACT_TOOL_DEFINITIONS,
    import_firmware,
    read_tool_contract,
)
from .public_contracts import public_remote_tool, with_error_schema

Record = dict[str, Any]
_EMPTY = obj({}, strict=True)
_COMPUTER_ID = obj({"computerId": string(1)}, strict=True)
_SERVER_ID = obj({"serverId": string(1)}, strict=True)
_HARDWARE_ID = obj({"hardwareId": string(1)}, strict=True)
_WIRING_TASK_ID = obj({"wiringTaskId": string(1)}, strict=True)
_ENDPOINT = union(string(1), obj({"hardwareId": string(1), "portId": string(1)}, strict=True))
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
    "add_managed_hardware_to_canvas": _HARDWARE_ID,
    "request_wiring_task": obj(
        {
            "portA": _ENDPOINT,
            "portB": _ENDPOINT,
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
    "list_workspace_files": obj({}, strict=True),
    "read_workspace_file": obj({"path": string(1)}, strict=True),
    "write_workspace_file": obj(
        {"path": string(1), "content": string(), "expectedHash": string()}, strict=True
    ),
    "initialize_workspace": obj({"online": boolean().default(False)}, strict=True),
    "validate_python_file": obj({"path": string(1)}, strict=True),
    "start_python_run": obj(
        {
            "entrypoint": string(1),
            "inputs": record(unknown()).default({}),
            "inputSchema": record(unknown()).default({}),
            "hardwareIds": array(string(1)).default([]),
            "name": string(1).optional(),
        },
        strict=True,
    ),
    "cancel_python_run": obj({"runId": string(1)}, strict=True),
    "get_python_run": obj({"runId": string(1)}, strict=True),
    "list_python_runs": obj(
        {
            "limit": number(1, 10000, integer=True).default(100),
            "search": string().optional(),
            "offset": number(0, None, integer=True).default(0),
            "status": enum(
                "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"
            ).optional(),
        },
        strict=True,
    ),
    "get_python_run_events": obj(
        {
            "runId": string(1),
            "after": number(0, None, integer=True).default(0),
            "limit": number(1, 1000, integer=True).default(500),
        },
        strict=True,
    ),
}
_ARGUMENT_SCHEMAS.update(AGENT_ARGUMENT_SCHEMAS)
_ARGUMENT_SCHEMAS.update(CONTRACT_ARGUMENT_SCHEMAS)


@dataclass
class GatewayToolDefinition:
    tool: Record
    capability: str

    def parse(self, value: Any) -> Record:
        return parse_record(_ARGUMENT_SCHEMAS[self.tool["name"]], value)

    async def execute(self, application: Any, context: Record, value: Record) -> Record:
        name = self.tool["name"]
        if name in AGENT_ARGUMENT_SCHEMAS:
            return {"ok": True, "data": await invoke_agent_tool(application, context, name, value)}
        if name == "import_firmware_artifact":
            return {"ok": True, "data": await import_firmware(application, context, value)}
        if name == "request_wiring_task":
            value = dict(value)
            for key in ("portA", "portB"):
                if isinstance(value[key], dict):
                    value[key] = f"{value[key]['hardwareId']}.{value[key]['portId']}"
        handler, arguments = _handler_arguments(application, context, self.tool["name"], value)
        data = handler(*arguments)
        if inspect.isawaitable(data):
            data = await data
        if name in {"list_hardware_catalog", "list_managed_hardware"} and isinstance(data, list):
            data = [_with_endpoints(item) for item in data]
        elif name == "get_hardware_definition" and isinstance(data, dict):
            data = _with_endpoints(data)
        return {"ok": True, "data": data}


BUILTIN_TOOL_DEFINITIONS = [
    GatewayToolDefinition(item["tool"], item["capability"])
    for resource in ("project_tools.json", "builtin_tools.json")
    for item in json_parse(files(__package__).joinpath(resource).read_text("utf-8"))
]
BUILTIN_TOOL_DEFINITIONS.extend(
    GatewayToolDefinition(item["tool"], item["capability"])
    for item in [*AGENT_TOOL_DEFINITIONS, *CONTRACT_TOOL_DEFINITIONS]
)


def _with_endpoints(hardware: Record) -> Record:
    result = clone(hardware)
    for port in result.get("ports", []):
        port["endpointRef"] = f"{result['hardwareId']}.{port['portId']}"
        port["endpoint"] = {"hardwareId": result["hardwareId"], "portId": port["portId"]}
    return result


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
            {
                **clone(definition.tool),
                "outputSchema": with_error_schema(definition.tool["outputSchema"]),
            }
            for definition in self._builtin.values()
            if self.application.authorizer.is_allowed(context, definition.capability)
        ]

    def list(self, context: Record) -> list[Record]:
        output = self.list_builtin(context)
        if self.application.authorizer.is_allowed(context, "hardware.executeTools"):
            output += [
                public_remote_tool(tool) for tool in self.application.devices.list_tools(context)
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
            parsed = builtin.parse(args)
            if name == "get_tool_contract":
                return {"ok": True, "data": read_tool_contract(self, context, parsed)}
            result = await builtin.execute(self.application, context, parsed)
            if name == "get_agent_context":
                result["data"]["catalogRevision"] = hashlib.sha256(
                    repr(self.list(context)).encode()
                ).hexdigest()
            return result
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
    devices, wiring, applications = (
        app.devices,
        app.wiring,
        app.applications,
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
        "list_workspace_files": (applications.list_files, []),
        "read_workspace_file": (applications.read_file, [value.get("path")]),
        "write_workspace_file": (applications.write_file, [value]),
        "initialize_workspace": (applications.initialize_workspace, [value]),
        "validate_python_file": (applications.diagnostics, [value.get("path")]),
        "start_python_run": (applications.start_run, [value]),
        "cancel_python_run": (applications.cancel_run, [value.get("runId")]),
        "get_python_run": (applications.get_run, [value.get("runId")]),
        "list_python_runs": (applications.list_runs, [value]),
        "get_python_run_events": (
            applications.run_events,
            [value.get("runId"), value.get("after"), value.get("limit")],
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
