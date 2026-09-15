"""On-demand tool contracts and project-to-service firmware transfer."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from pathlib import Path
from typing import Any

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.contracts.validation import number, obj, string

from .public_contracts import (
    CONTRACT_REVISION,
    sdk_data_schema,
    sdk_envelope_schema,
    success_schema,
)

Record = dict[str, Any]
_FIRMWARE_LIMIT = 32 * 1024 * 1024
CONTRACT_ARGUMENT_SCHEMAS = {
    "get_tool_contract": obj(
        {
            "toolName": string(1).optional(),
            "query": string().optional(),
            "offset": number(0, None, integer=True).default(0),
            "limit": number(1, 100, integer=True).default(20),
        },
        strict=True,
    ),
    "import_firmware_artifact": obj(
        {
            "serverId": string(1),
            "path": string(1),
            "expectedSha256": string(64).optional(),
        },
        strict=True,
    ),
}


def _definition(
    name: str,
    description: str,
    properties: Record,
    required: list[str],
    capability: str,
    data: Record,
    *,
    readonly: bool,
) -> Record:
    return {
        "capability": capability,
        "tool": {
            "name": name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
            "outputSchema": success_schema(data),
            "annotations": {
                "readOnlyHint": readonly,
                "destructiveHint": False,
                "idempotentHint": readonly,
                "openWorldHint": not readonly,
            },
            "_meta": {
                "hardwareharness": {"contractRevision": CONTRACT_REVISION, "kind": "platform"}
            },
        },
    }


CONTRACT_TOOL_DEFINITIONS = [
    _definition(
        "get_tool_contract",
        "Read one exact public tool contract, including gateway/SDK result shapes and recovery. "
        "Omit toolName to search/page the catalog. Copy SDK names from this contract.",
        {
            "toolName": {
                "type": "string",
                "minLength": 1,
                "description": "Exact name from tools/list; omit to search.",
            },
            "query": {
                "type": "string",
                "description": "Case-insensitive name/description substring for discovery.",
            },
            "offset": {
                "type": "integer",
                "minimum": 0,
                "default": 0,
                "description": "Zero-based catalog offset.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 20,
                "description": "Maximum catalog matches per page.",
            },
        },
        [],
        "projects.read",
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
        readonly=True,
    ),
    _definition(
        "import_firmware_artifact",
        "Import a USER project firmware file into a selected service's managed immutable storage. "
        "HH transfers bytes internally (up to 32 MiB), checks SHA-256 and returns the server path. "
        "Inspect the returned file before flash; BIN requires an explicit base address.",
        {
            "serverId": {
                "type": "string",
                "minLength": 1,
                "description": "Server from list_mcp_servers exposing firedap_import_firmware.",
            },
            "path": {
                "type": "string",
                "minLength": 1,
                "description": "Relative USER project .bin/.hex/.ihex/.elf/.axf file; "
                "escapes and outside symlink targets rejected.",
            },
            "expectedSha256": {
                "type": "string",
                "pattern": "^[0-9a-fA-F]{64}$",
                "description": "Expected SHA-256; mismatch aborts before any transfer.",
            },
        },
        ["serverId", "path"],
        "hardware.executeTools",
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
        readonly=False,
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
        "referenceId": "hh-sdk",
    }
    if registry.application.authorizer.is_allowed(context, "hardware.executeTools"):
        remote = next(
            (
                t
                for t in registry.application.devices.list_tools(context)
                if t["externalName"] == name
            ),
            None,
        )
        if remote:
            result["sdk"] = {
                "toolName": remote["externalName"],
                "remoteToolName": remote["remoteName"],
                "serverId": remote["serverId"],
                "hardwareIdSource": "list_mcp_servers: matching serverId.hardwareId",
                "defaultResultMode": "envelope",
                "resultModes": ["envelope", "data"],
                "envelopeSchema": sdk_envelope_schema(remote.get("upstreamOutputSchema")),
                "dataSchema": sdk_data_schema(remote.get("upstreamOutputSchema")),
                "example": f"result = call(hardware_id, {remote['externalName']!r}, "
                "arguments, result_mode='data')",
                "media": "Envelope mode retains MCP images, resources and other content blocks.",
            }
    return result


async def import_firmware(application: Any, context: Record, arguments: Record) -> Any:
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
    return await application.devices.call_tool(
        context,
        name,
        {
            "filename": candidate.name,
            "content_base64": base64.b64encode(data).decode("ascii"),
            "expected_sha256": digest,
        },
    )
