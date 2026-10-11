"""The Agent's tool catalog (design doc 8.1, 8.2, 9.3).

Curated tools present registry operations under Agent-oriented names and schemas; every other
operation with work-mode ``profiles`` becomes a generated tool named after it (``.`` → ``_``).
Operation tools run through ``OperationRegistry.invoke``, so capability, confirmation, request-id
replay, audit and ``unknown_outcome`` apply exactly as over HTTP; remote device tools run through
the ``devices.callTool`` operation. A session's work mode (``context["mode"]``) limits the catalog
to the tools whose profiles contain it; without a mode every tool is listed.

Device tools are not flattened into an Agent session's catalog: the session context carries
``ENABLED_HARDWARE`` and lists, and may call, only the tools of hardware the Agent expanded with
``enable_device_tools``. A context without it (host introspection) sees every device tool.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from teststand_backend import CONTRACT_REVISION
from teststand_backend.application import OPERATIONS
from teststand_backend.application.registry import OperationRegistry
from teststand_backend.application.streams import STREAM_TOOLS
from teststand_backend.application.tools import PLATFORM_TOOLS
from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.mcp import (
    public_remote_tool,
    success_schema,
    with_error_schema,
)
from teststand_backend.contracts.operations import OperationDefinition, Tool
from teststand_backend.testing.tools import TESTING_TOOLS
from teststand_backend.util import clone

from .agent_services import AGENT_TOOLS
from .contract_tools import CONTRACT_TOOLS, read_tool_contract

Record = dict[str, Any]
Run = Callable[[Record, Record], Awaitable[Any]]

BUILTIN_TOOLS: list[Tool] = [
    *PLATFORM_TOOLS,
    *AGENT_TOOLS,
    *CONTRACT_TOOLS,
    *STREAM_TOOLS,
    *TESTING_TOOLS,
]
"""Curated tools; profiled operations without one are generated."""
REMOTE_CALL = "devices.callTool"
NOT_GENERATED = frozenset({REMOTE_CALL, "devices.listTools"})
"""Operations the catalog represents as the remote device tools themselves."""
ENABLED_HARDWARE = "enabledHardware"
"""Session context key: hardware whose device tools the Agent enabled."""


@dataclass(frozen=True)
class _Entry:
    definition: Record
    capability: str
    profiles: frozenset[str]
    """Work modes listing the tool; empty: every mode."""
    run: Run
    waits: bool = False


def tool_annotations(definition: OperationDefinition, open_world: bool) -> Record:
    """MCP annotations derived from the operation's risk and idempotency (design doc 9.3)."""
    read = definition.spec.risk == "read"
    return {
        "readOnlyHint": read,
        "destructiveHint": not read,
        "idempotentHint": read or definition.spec.idempotency != "none",
        "openWorldHint": open_world,
    }


def generated_definition(definition: OperationDefinition) -> Record:
    schema = definition.request.model_json_schema(by_alias=True)
    schema.pop("title", None)
    data = dict(definition.response_schema)
    defs = data.pop("$defs", None)
    # An untyped result is any object: MCP clients reject a boolean `true` schema here.
    output = success_schema(data or {})
    if defs:
        output["$defs"] = defs
    return {
        "name": definition.name.replace(".", "_"),
        "description": definition.summary or f"Operation {definition.name}.",
        "inputSchema": schema,
        "outputSchema": output,
        "annotations": tool_annotations(definition, definition.spec.risk == "actuate"),
        "_meta": {
            "teststand": {
                "contractRevision": CONTRACT_REVISION,
                "kind": "operation",
                "operation": definition.name,
                "resultMode": "data",
            }
        },
    }


_QUOTED_IDENTIFIER = re.compile(r'^"[A-Za-z0-9_.:/\\-]+"$')


def unquote_identifiers(args: Record) -> Record:
    """Some models (seen with grok over Chat Completions) send top-level string arguments
    JSON-encoded twice: ``{"hardwareId": "\\"PCI1762_CARD_0\\""}``. An id, name or path
    wrapped in one extra pair of quotes is unwrapped; any other text is passed as sent."""
    return {
        key: value[1:-1] if isinstance(value, str) and _QUOTED_IDENTIFIER.match(value) else value
        for key, value in args.items()
    }


class ToolRegistry:
    def __init__(
        self,
        application: Any,
        tools: list[Tool] | None = None,
        *,
        operations: OperationRegistry | None = None,
    ) -> None:
        self.application = application
        self.operations = operations or OperationRegistry(application, OPERATIONS)
        self._entries: dict[str, _Entry] = {}
        curated = BUILTIN_TOOLS if tools is None else tools
        for tool in curated:
            self._add(tool.name, self._curated(tool))
        if tools is None:
            used = {tool.operation for tool in curated}
            for definition in self.operations.definitions.values():
                if definition.spec.profiles and definition.name not in used | NOT_GENERATED:
                    self._add(definition.name.replace(".", "_"), self._generated(definition))
        self._own: dict[str, Run] = {
            "get_tool_contract": self._tool_contract,
            "list_device_tools": self._list_device_tools,
            "enable_device_tools": self._enable_device_tools,
        }

    def _add(self, name: str, entry: _Entry) -> None:
        if name in self._entries:
            raise RuntimeError(f"Duplicate builtin MCP tool name: {name}")
        self._entries[name] = entry

    def _curated(self, tool: Tool) -> _Entry:
        definition = tool.definition()
        definition["outputSchema"] = with_error_schema(definition["outputSchema"])
        if not tool.operation:
            return _Entry(definition, tool.capability, tool.profiles, self._gateway_call(tool))
        operation = self.operations.definitions.get(tool.operation)
        if operation is None:
            raise RuntimeError(f"{tool.name}: unknown operation {tool.operation}")
        parameters = [wire for wire, _ in operation.parameters]
        if len(tool.fields) > len(parameters):
            raise RuntimeError(f"{tool.name}: more fields than {tool.operation} parameters")
        definition["annotations"] = tool_annotations(operation, tool.open_world)

        async def run(context: Record, arguments: Record) -> Any:
            value = tool.parse(arguments)
            if tool.check is not None:
                checked = tool.check(self.application, context)
                if inspect.isawaitable(checked):
                    await checked
            payload = tool.payload(parameters, value)
            result = await self.operations.invoke(context, operation.name, payload)
            return result if tool.result is None else tool.result(result)

        return _Entry(
            definition,
            operation.spec.capability,
            operation.spec.profiles,
            run,
            tool.waits or operation.spec.confirm,
        )

    def _generated(self, definition: OperationDefinition) -> _Entry:
        async def run(context: Record, arguments: Record) -> Any:
            # JSON, so that bytes fields arrive base64 encoded as the input schema says.
            return await self.operations.invoke(context, definition.name, json.dumps(arguments))

        public = generated_definition(definition)
        public["outputSchema"] = with_error_schema(public["outputSchema"])
        # An operation the operator confirms waits for a person: a client that gives up must
        # withdraw the question, not leave an approvable request behind (design doc 8.4).
        return _Entry(
            public,
            definition.spec.capability,
            definition.spec.profiles,
            run,
            definition.spec.confirm,
        )

    def _gateway_call(self, tool: Tool) -> Run:
        async def run(context: Record, arguments: Record) -> Any:
            value = tool.parse(arguments)
            own = self._own.get(tool.name)
            if own is not None:
                return await own(context, value)
            data = await tool.execute(self.application, context, value)
            if tool.name == "get_agent_context":
                data["catalogRevision"] = hashlib.sha256(
                    repr(self.list(context)).encode()
                ).hexdigest()
            return data

        return run

    async def _tool_contract(self, context: Record, value: Record) -> Any:
        return read_tool_contract(self, context, value)

    def _hardware_of(self, context: Record) -> dict[str, str]:
        """``{deviceId: hardwareId}``; a instance without one stands for itself."""
        instances = self.application.devices.list_devices(context)
        return {
            str(item["deviceId"]): str(item.get("hardwareId") or item["deviceId"])
            for item in instances
        }

    def _device_tools(self, context: Record, hardware_id: str) -> list[Record]:
        hardware = self._hardware_of(context)
        return [
            tool
            for tool in self.application.devices.list_tools(context)
            if hardware.get(tool["deviceId"], tool["deviceId"]) == hardware_id
        ]

    async def _list_device_tools(self, context: Record, value: Record) -> Any:
        hardware_id = value["hardwareId"]
        tools = [
            {
                "name": tool["externalName"],
                "description": tool.get("description", ""),
                "kind": tool.get("kind", "unknown"),
                **({"annotations": clone(tool["annotations"])} if tool.get("annotations") else {}),
            }
            for tool in self._device_tools(context, hardware_id)
        ]
        enabled = context.get(ENABLED_HARDWARE)
        return {
            "hardwareId": hardware_id,
            "enabled": enabled is None or hardware_id in enabled,
            "tools": tools,
        }

    async def _enable_device_tools(self, context: Record, value: Record) -> Any:
        hardware_id = value["hardwareId"]
        tools = self._device_tools(context, hardware_id)
        if not tools:
            raise app_error(
                "not_found",
                f"Hardware {hardware_id} exposes no device tools",
                {
                    "hardwareId": hardware_id,
                    "recovery": "Check the hardware ID and that its device is connected.",
                },
            )
        enabled = context.get(ENABLED_HARDWARE)
        if enabled is not None and hardware_id not in enabled:
            enabled.append(hardware_id)
        return {
            "hardwareId": hardware_id,
            "enabledHardware": list(enabled) if enabled is not None else [hardware_id],
            "tools": [tool["externalName"] for tool in tools],
        }

    def _enabled_remote_tools(self, context: Record) -> list[Record]:
        tools = self.application.devices.list_tools(context)
        enabled = context.get(ENABLED_HARDWARE)
        if enabled is None:
            return list(tools)
        if not enabled:
            return []
        hardware = self._hardware_of(context)
        return [t for t in tools if hardware.get(t["deviceId"], t["deviceId"]) in enabled]

    @staticmethod
    def _in_mode(profiles: frozenset[str], context: Record) -> bool:
        mode = context.get("mode")
        return not mode or not profiles or mode in profiles

    def _remote_visible(self, context: Record) -> bool:
        remote = self.operations.definitions.get(REMOTE_CALL)
        return remote is not None and self._in_mode(remote.spec.profiles, context)

    def waits(self, name: str) -> bool:
        """Whether tool ``name`` blocks until a person answers it: it asks the operator
        (``request_wiring``) or its operation needs the operator's confirmation."""
        entry = self._entries.get(name)
        return entry is not None and entry.waits

    def list_builtin(self, context: Record) -> list[Record]:
        is_allowed = self.application.authorizer.is_allowed
        return [
            clone(entry.definition)
            for entry in self._entries.values()
            if self._in_mode(entry.profiles, context) and is_allowed(context, entry.capability)
        ]

    def list(self, context: Record) -> list[Record]:
        output = self.list_builtin(context)
        if self._remote_visible(context) and self.application.authorizer.is_allowed(
            context, "hardware.executeTools"
        ):
            output += [public_remote_tool(tool) for tool in self._enabled_remote_tools(context)]
        names = set()
        for tool in output:
            if tool["name"] in names:
                raise app_error("conflict", f"Duplicate MCP tool name: {tool['name']}")
            names.add(tool["name"])
        return output

    async def invoke(self, context: Record, name: str, args: Record) -> Record:
        args = unquote_identifiers(args)
        entry = self._entries.get(name)
        if entry is not None:
            if not self._in_mode(entry.profiles, context):
                raise app_error(
                    "not_found",
                    f"{name} is not available in {context.get('mode')} mode",
                    {"tool": name, "mode": context.get("mode")},
                )
            self.application.authorizer.authorize(context, entry.capability)
            return {"ok": True, "data": await entry.run(context, args)}
        if not self._remote_visible(context):
            raise app_error("not_found", f"Unknown MCP tool: {name}")
        self.application.authorizer.authorize(context, "hardware.executeTools")
        if not any(tool["externalName"] == name for tool in self._enabled_remote_tools(context)):
            if any(
                tool["externalName"] == name
                for tool in self.application.devices.list_tools(context)
            ):
                raise app_error(
                    "not_found",
                    f"Device tool {name} is not enabled in this session",
                    {"recovery": "Call enable_device_tools for its hardware first."},
                )
            raise app_error("not_found", f"Unknown MCP tool: {name}")
        return {"ok": True, "data": await self.call_device_tool(context, name, args)}

    async def call_device_tool(self, context: Record, name: str, args: Record) -> Any:
        """Call a remote device tool through the ``devices.callTool`` operation middleware."""
        return await self.operations.invoke(context, REMOTE_CALL, {"name": name, "args": args})
