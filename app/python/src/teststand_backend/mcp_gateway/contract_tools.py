"""On-demand tool contracts."""

from __future__ import annotations

import hashlib
from typing import Any

from teststand_backend import CONTRACT_REVISION
from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.operations import Tool
from teststand_backend.contracts.validation import number, obj, string

Record = dict[str, Any]
_META = {"kind": "platform"}


def _unreachable(app: Any, context: Record, value: Record) -> Any:
    raise RuntimeError("Contract tools are answered by the tool registry")


CONTRACT_TOOLS = [
    Tool(
        "get_tool_contract",
        "Read one exact public tool contract, including gateway result shapes and recovery. "
        "Omit toolName to search/page the catalog. Copy tool names from this contract.",
        obj(
            {
                "toolName": string(1)
                .optional()
                .describe("Exact name from tools/list; omit to search."),
                "query": string()
                .optional()
                .describe("Case-insensitive name/description substring for discovery."),
                "offset": number(0, None, integer=True)
                .default(0)
                .describe("Zero-based catalog offset."),
                "limit": number(1, 100, integer=True)
                .default(20)
                .describe("Maximum catalog matches per page."),
            },
            strict=True,
        ),
        {
            "type": "object",
            "properties": {
                "contractRevision": {"type": "string"},
                "tool": {"type": "object"},
                "items": {"type": "array", "items": {"type": "object"}},
                "hasMore": {"type": "boolean"},
                "nextOffset": {"type": ["integer", "null"]},
            },
            "required": ["contractRevision"],
        },
        call=_unreachable,
        capability="projects.read",
        read_only=True,
        meta=_META,
    ),
    Tool(
        "list_device_tools",
        "List one hardware's device tools (names, descriptions, kinds) without adding them to "
        "tools/list. Call enable_device_tools to make them callable in this session.",
        obj(
            {"hardwareId": string(1).describe("Hardware from get_agent_context or list_hardware.")},
            strict=True,
        ),
        {
            "type": "object",
            "properties": {
                "hardwareId": {"type": "string"},
                "enabled": {"type": "boolean"},
                "tools": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["hardwareId", "enabled", "tools"],
        },
        call=_unreachable,
        capability="hardware.executeTools",
        read_only=True,
        profiles=frozenset({"adapter", "explore"}),
        meta=_META,
    ),
    Tool(
        "enable_device_tools",
        "Add one hardware's device tools to this session's tools/list (design 8.2). Expand only "
        "the hardware you are working on; read a tool's contract before calling it.",
        obj(
            {"hardwareId": string(1).describe("Hardware whose tools to enable.")},
            strict=True,
        ),
        {
            "type": "object",
            "properties": {
                "hardwareId": {"type": "string"},
                "enabledHardware": {"type": "array", "items": {"type": "string"}},
                "tools": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["hardwareId", "enabledHardware", "tools"],
        },
        call=_unreachable,
        capability="hardware.executeTools",
        idempotent=True,
        profiles=frozenset({"adapter", "explore"}),
        meta=_META,
    ),
]


def read_tool_contract(registry: Any, context: Record, arguments: Record) -> Record:
    catalog = registry.list(context)
    revision = hashlib.sha256(repr(catalog).encode()).hexdigest()
    base = {"contractRevision": CONTRACT_REVISION, "catalogRevision": revision}
    name = arguments.get("toolName")
    if not name:
        query = arguments.get("query", "").casefold()
        matches = [
            item
            for item in catalog
            if query in (item["name"] + " " + item.get("description", "")).casefold()
        ]
        offset, limit = arguments.get("offset", 0), arguments.get("limit", 20)
        end = offset + limit
        return {
            **base,
            "items": [
                {"name": t["name"], "description": t.get("description", "")}
                for t in matches[offset:end]
            ],
            "total": len(matches),
            "hasMore": end < len(matches),
            "nextOffset": end if end < len(matches) else None,
        }
    # Agents see the tools under their MCP client's prefix (OpenCode: ``teststand_<name>``).
    for candidate in (name, name.removeprefix("teststand_"), name.removeprefix("teststand__")):
        tool = next((item for item in catalog if item["name"] == candidate), None)
        if tool is not None:
            break
    if tool is None:
        raise app_error(
            "not_found",
            f"Unknown authorized public tool: {name}",
            {"recovery": "Search get_tool_contract without toolName; copy a returned name."},
        )
    result = {
        **base,
        "tool": tool,
        "agentResultSchema": tool["outputSchema"],
        "errorContract": {
            "shape": {
                "ok": False,
                "error": {"category": "string", "message": "string", "details": "optional object"},
            },
            "recovery": {
                "invalid_argument": "Correct parameters using inputSchema and public references.",
                "conflict": "Read execution availability or the returned existing task; "
                "reread a changed file before merging.",
                "unavailable": "Inspect service/job status. Timeout or cancellation may "
                "leave a physical result unknown.",
            },
            "automaticActionReplay": False,
        },
        "referenceId": "ts-agent-interface",
    }
    return result
