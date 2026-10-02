"""On-demand tool contracts and project-to-service firmware transfer."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from hardwareharness_backend import CONTRACT_REVISION
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.contracts.operations import Tool
from hardwareharness_backend.contracts.validation import number, obj, string

Record = dict[str, Any]
DeviceToolCall = Callable[[Record, str, Record], Awaitable[Any]]
_FIRMWARE_LIMIT = 32 * 1024 * 1024
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
        "import_firmware_artifact",
        "Import a USER project firmware file into a selected service's managed immutable storage. "
        "HH transfers bytes internally (up to 32 MiB), checks SHA-256 and returns the server path. "
        "Inspect the returned file before flash; BIN requires an explicit base address.",
        obj(
            {
                "serverId": string(1).describe(
                    "Server from list_mcp_servers exposing firedap_import_firmware."
                ),
                "path": string(1).describe(
                    "Relative USER project .bin/.hex/.ihex/.elf/.axf file; "
                    "escapes and outside symlink targets rejected."
                ),
                "expectedSha256": string(64, 64, regex="^[0-9a-fA-F]{64}$")
                .optional()
                .describe("Expected SHA-256; mismatch aborts before any transfer."),
            },
            strict=True,
        ),
        {
            "type": "object",
            "properties": {
                "artifactId": {"type": "string"},
                "path": {"type": "string"},
                "sha256": {"type": "string"},
                "fileBytes": {"type": "integer"},
                "immutable": {"const": True},
                "requiresInspection": {"const": True},
            },
            "required": ["artifactId", "path", "sha256", "fileBytes"],
        },
        call=_unreachable,
        capability="hardware.executeTools",
        open_world=True,
        profiles=frozenset({"adapter", "explore"}),
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
    tool = next((item for item in catalog if item["name"] == name), None)
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
        "referenceId": "hh-agent-interface",
    }
    return result


async def import_firmware(
    application: Any,
    context: Record,
    arguments: Record,
    call_tool: DeviceToolCall | None = None,
) -> Any:
    """Send a project firmware file to a FireDAP service; ``call_tool`` runs the device tool
    (the gateway passes its ``devices.callTool`` route through the registry middleware)."""
    application.authorizer.authorize(context, "projects.read")
    name = f"{arguments['serverId']}__firedap_import_firmware"
    if not any(t["externalName"] == name for t in application.devices.list_tools(context)):
        raise app_error(
            "unavailable",
            "Selected service does not expose managed firmware import",
            {
                "serverId": arguments["serverId"],
                "recovery": "Connect/update FireDAP and refresh its public tool catalog.",
            },
        )
    project = application.projects.document(context)
    if not project:
        raise app_error("requires_project", "Open a user project before importing firmware")
    root = Path(project["rootPath"]).resolve()
    relative = Path(arguments["path"])
    candidate = (root / relative).resolve()
    if relative.is_absolute() or not candidate.is_relative_to(root) or not candidate.is_file():
        raise app_error(
            "invalid_argument", "Firmware must be an existing file inside the user project"
        )
    if candidate.suffix.casefold() not in {".bin", ".hex", ".ihex", ".elf", ".axf"}:
        raise app_error(
            "invalid_argument", "Supported firmware extensions: .bin/.hex/.ihex/.elf/.axf"
        )

    def read() -> bytes:
        with candidate.open("rb") as stream:
            return stream.read(_FIRMWARE_LIMIT + 1)

    data = await asyncio.to_thread(read)
    if not data or len(data) > _FIRMWARE_LIMIT:
        raise app_error("invalid_argument", "Firmware must be between 1 byte and 32 MiB")
    digest = hashlib.sha256(data).hexdigest()
    if arguments.get("expectedSha256", digest).lower() != digest:
        raise app_error(
            "conflict", "Firmware hash changed; no transfer performed", {"actualSha256": digest}
        )
    call = call_tool or application.devices.call_tool
    return await call(
        context,
        name,
        {
            "filename": candidate.name,
            "content_base64": base64.b64encode(data).decode("ascii"),
            "expected_sha256": digest,
        },
    )
