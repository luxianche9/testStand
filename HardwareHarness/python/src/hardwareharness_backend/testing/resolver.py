from __future__ import annotations

from typing import Any

from hardwareharness_backend.contracts.mcp import business_result_schema
from hardwareharness_backend.util import clone

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
        resolved["hardwareId"] = hardware_id
        resolved["toolName"] = tool_name
        resolved["resultSchema"] = business_result_schema(resolved.get("upstreamOutputSchema"))
        resolved["operationSemantics"] = _operation_semantics(resolved)
        resolved["bindingRevision"] = schema_hash(
            {
                "input": resolved.get("inputSchema", {}),
                "result": resolved["resultSchema"],
                "operationSemantics": resolved["operationSemantics"],
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
        tools = []
        for item in self.devices.list_tools():
            if item.get("serverId") != server.get("serverId"):
                continue
            result_schema = business_result_schema(item.get("upstreamOutputSchema"))
            semantics = _operation_semantics(item)
            binding_revision = schema_hash(
                {
                    "input": item.get("inputSchema", {}),
                    "result": result_schema,
                    "operationSemantics": semantics,
                }
            )
            tools.append(
                {
                    "hardwareId": hardware_id,
                    "toolName": item["remoteName"],
                    "publicToolName": item["externalName"],
                    "description": item.get("description", ""),
                    "inputSchema": item.get("inputSchema", {}),
                    "resultSchema": result_schema,
                    "outputSchema": result_schema,
                    "annotations": item.get("annotations", {}),
                    "bindingRevision": binding_revision,
                    "operationSemantics": semantics,
                }
            )
        return {"hardwareId": hardware_id, "tools": tools, "issues": []}


def _operation_semantics(tool: Record) -> Record:
    metadata = tool.get("contractMetadata", {})
    declared = metadata.get("operationSemantics")
    if not isinstance(declared, dict):
        declared = metadata.get("semantics")
    if isinstance(declared, dict):
        return clone(declared)
    annotations = tool.get("annotations", {})
    name = str(tool.get("remoteName", ""))
    known_hh_tool = name.startswith(("pci1710l_", "pci1762_", "pci6208v_", "cp118u_", "firedap_"))
    read_only = bool(annotations.get("readOnlyHint"))
    idempotent = bool(annotations.get("idempotentHint"))
    if name.startswith(("get_", "list_")) or any(
        token in name for token in ("_read_", "_get_", "target_info")
    ):
        read_only = True
    if any(token in name for token in ("configure", "safe_state")):
        idempotent = True
    evidence = metadata.get("evidence")
    kind = (
        "safe"
        if name.endswith("safe_state")
        else "read"
        if read_only
        else "configure"
        if "configure" in name
        else "actuate"
    )
    requirements: list[str] = []
    effects: list[str] = []
    if name == "pci1710l_configure_ai":
        effects = ["analog_input_configured"]
    elif name == "pci1710l_read_voltage":
        requirements = ["analog_input_configured"]
    elif name == "cp118u_configure_port":
        effects = ["serial_port_configured"]
    elif name.startswith("cp118u_") and name != "cp118u_configure_port":
        requirements = ["serial_port_configured"]
    safety: Record | None = None
    if name == "pci6208v_set_voltage":
        safety = {"toolName": "pci6208v_safe_state", "arguments": {}}
    elif name in {"pci1762_set_relay", "pci1762_set_bank"}:
        safety = {"toolName": "pci1762_safe_state", "arguments": {}}
    evidence_type = (
        evidence
        if isinstance(evidence, str)
        else (
            "measurement"
            if any(token in name for token in ("read_voltage", "read_bit", "read_rx"))
            else "controller_state"
            if read_only
            else "observation"
        )
    )
    return {
        "kind": kind,
        "retry": "safe" if read_only or idempotent else "never_after_dispatch",
        "stateRequirements": requirements,
        "stateEffects": effects,
        "evidenceType": evidence_type,
        "outcomeOnInvalidResponse": "unknown",
        "trusted": bool(metadata) or known_hh_tool,
        **({"safetyAction": safety} if safety else {}),
    }
