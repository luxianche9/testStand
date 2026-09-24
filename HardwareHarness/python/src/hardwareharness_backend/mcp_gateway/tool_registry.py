from __future__ import annotations

import hashlib
from typing import Any

from hardwareharness_backend.application import operation_capability
from hardwareharness_backend.application.tools import PLATFORM_TOOLS
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.contracts.mcp import public_remote_tool, with_error_schema
from hardwareharness_backend.contracts.operations import Tool
from hardwareharness_backend.testing.tools import TESTING_TOOLS

from .agent_services import AGENT_TOOLS
from .contract_tools import CONTRACT_TOOLS, read_tool_contract

Record = dict[str, Any]

BUILTIN_TOOLS: list[Tool] = [*PLATFORM_TOOLS, *AGENT_TOOLS, *CONTRACT_TOOLS, *TESTING_TOOLS]


class ToolRegistry:
    def __init__(self, application: Any, tools: list[Tool] | None = None) -> None:
        self.application = application
        self._builtin: dict[str, tuple[Tool, str]] = {}
        for tool in BUILTIN_TOOLS if tools is None else tools:
            if tool.name in self._builtin:
                raise RuntimeError(f"Duplicate builtin MCP tool name: {tool.name}")
            capability = tool.capability or operation_capability(tool.operation)
            self._builtin[tool.name] = (tool, capability)

    def list_builtin(self, context: Record) -> list[Record]:
        output = []
        for tool, capability in self._builtin.values():
            if self.application.authorizer.is_allowed(context, capability):
                definition = tool.definition()
                output.append(
                    {**definition, "outputSchema": with_error_schema(definition["outputSchema"])}
                )
        return output

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
            tool, capability = builtin
            self.application.authorizer.authorize(context, capability)
            parsed = tool.parse(args)
            if name == "get_tool_contract":
                return {"ok": True, "data": read_tool_contract(self, context, parsed)}
            data = await tool.execute(self.application, context, parsed)
            if name == "get_agent_context":
                data["catalogRevision"] = hashlib.sha256(
                    repr(self.list(context)).encode()
                ).hexdigest()
            return {"ok": True, "data": data}
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
