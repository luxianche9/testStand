from __future__ import annotations

from typing import Any

from hardwareharness_backend.compat import clone

from .models import schema_hash
from .validation import issue

Record = dict[str, Any]


class DeviceToolResolver:
    def __init__(self, devices: Any, catalog: Any) -> None:
        self.devices, self.catalog = devices, catalog

    def resolve(self, hardware_id: str, tool_name: str) -> tuple[Record | None, list[Record]]:
        hardware = self.catalog.find_hardware(hardware_id)
        if hardware is None:
            return None, [
                issue(
                    "error",
                    "device.missing",
                    f"Hardware {hardware_id} does not exist",
                    "/hardwareId",
                )
            ]
        if hardware.get("kind") != "managed":
            return None, [
                issue(
                    "error",
                    "device.unmanaged",
                    f"Hardware {hardware_id} is not managed",
                    "/hardwareId",
                )
            ]
        server = next(
            (item for item in self.devices.list_servers() if item.get("hardwareId") == hardware_id),
            None,
        )
        if server is None:
            return None, [
                issue(
                    "error",
                    "device.server_missing",
                    f"Hardware {hardware_id} has no MCP server",
                    "/hardwareId",
                )
            ]
        tool = next(
            (
                item
                for item in self.devices.list_tools()
                if item.get("serverId") == server.get("serverId")
                and item.get("remoteName") == tool_name
            ),
            None,
        )
        if tool is None:
            return None, [
                issue(
                    "error",
                    "tool.missing",
                    f"Tool {tool_name} is unavailable on {hardware_id}",
                    "/toolName",
                )
            ]
        resolved = clone(tool)
        resolved["inputSchemaHash"] = schema_hash(resolved.get("inputSchema", {}))
        resolved["toolContractRevision"] = schema_hash(
            {
                "input": resolved.get("inputSchema", {}),
                "output": resolved.get("upstreamOutputSchema", resolved.get("outputSchema", {})),
                "annotations": resolved.get("annotations", {}),
            }
        )
        return resolved, []

    def list_device_tools(self, hardware_id: str) -> Record:
        hardware = self.catalog.find_hardware(hardware_id)
        if hardware is None:
            return {
                "hardwareId": hardware_id,
                "tools": [],
                "issues": [
                    issue("error", "device.missing", f"Hardware {hardware_id} does not exist")
                ],
            }
        if hardware.get("kind") != "managed":
            return {
                "hardwareId": hardware_id,
                "tools": [],
                "issues": [
                    issue(
                        "error",
                        "device.unmanaged",
                        f"Hardware {hardware_id} is not managed",
                    )
                ],
            }
        server = next(
            (item for item in self.devices.list_servers() if item.get("hardwareId") == hardware_id),
            None,
        )
        if server is None:
            return {
                "hardwareId": hardware_id,
                "tools": [],
                "issues": [
                    issue(
                        "error",
                        "device.server_missing",
                        f"Hardware {hardware_id} has no MCP server",
                    )
                ],
            }
        tools = [
            {
                "hardwareId": hardware_id,
                "toolName": item["remoteName"],
                "publicToolName": item["externalName"],
                "description": item.get("description", ""),
                "inputSchema": item.get("inputSchema", {}),
                "outputSchema": item.get("upstreamOutputSchema", item.get("outputSchema", {})),
                "annotations": item.get("annotations", {}),
                "toolContractRevision": schema_hash(
                    {
                        "input": item.get("inputSchema", {}),
                        "output": item.get("upstreamOutputSchema", item.get("outputSchema", {})),
                        "annotations": item.get("annotations", {}),
                    }
                ),
                "inputSchemaHash": schema_hash(item.get("inputSchema", {})),
            }
            for item in self.devices.list_tools()
            if item.get("serverId") == server.get("serverId")
        ]
        return {"hardwareId": hardware_id, "tools": tools, "issues": []}
