from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from jsonschema import Draft202012Validator

from hardwareharness_backend.application import DefaultAuthorizer, ExecutionCoordinator
from hardwareharness_backend.application.services import DevicesApplication
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.contracts.mcp import (
    normalized_output_schema,
    public_remote_tool,
    sdk_envelope_schema,
    with_error_schema,
)
from hardwareharness_backend.mcp_gateway.tool_registry import BUILTIN_TOOLS, ToolRegistry

Json = dict[str, Any]
CONTEXT = {"actor": "agent", "source": "mcp"}


def _check_fields(schema: Json) -> None:
    for field in schema.get("properties", {}).values():
        assert field.get("description")
        _check_fields(field)
    for branch in schema.get("oneOf", []) + schema.get("anyOf", []):
        _check_fields(branch)
    if isinstance(schema.get("items"), dict):
        _check_fields(schema["items"])


def test_every_builtin_has_a_valid_described_contract() -> None:
    names = set()
    for item in BUILTIN_TOOLS:
        tool = item.definition()
        assert tool["name"] not in names
        names.add(tool["name"])
        assert len(tool["description"]) > 20
        for field in ("inputSchema", "outputSchema"):
            Draft202012Validator.check_schema(tool[field])
        _check_fields(tool["inputSchema"])
        assert isinstance(tool["annotations"]["readOnlyHint"], bool)
    assert "get_tool_contract" in names
    assert not any("simulate" in name or "mock" in name or "shutdown" in name for name in names)


def test_gateway_and_sdk_shapes_keep_referenced_data_and_media_distinct() -> None:
    upstream: Json = {
        "type": "object",
        "properties": {"ok": {"const": True}, "data": {"$ref": "#/$defs/Reading"}},
        "required": ["ok", "data"],
        "$defs": {
            "Reading": {
                "type": "object",
                "properties": {"volts": {"type": "number"}},
                "required": ["volts"],
                "additionalProperties": False,
            }
        },
    }
    schema = normalized_output_schema(upstream)
    Draft202012Validator(schema).validate({"ok": True, "data": {"volts": 1.2}})
    assert not Draft202012Validator(schema).is_valid({"ok": True, "data": {"volts": "1.2"}})
    Draft202012Validator(sdk_envelope_schema(upstream)).validate(
        {
            "content": [{"type": "text", "text": "result"}],
            "structuredContent": {"ok": True, "data": {"volts": 1.2}},
        }
    )
    tool = public_remote_tool(
        {
            "externalName": "S__read",
            "remoteName": "read",
            "serverId": "S",
            "kind": "hardware",
            "inputSchema": {},
            "upstreamOutputSchema": upstream,
            "annotations": {"readOnlyHint": True},
            "execution": {"taskSupport": "required"},
        }
    )
    assert "execution" not in tool
    assert tool["annotations"]["readOnlyHint"] is True
    assert tool["_meta"]["hardwareharness"]["toolName"] == "S__read"
    assert tool["_meta"]["hardwareharness"]["remoteToolName"] == "read"


@pytest.mark.parametrize(
    "tool_name,kind,allowed",
    [
        ("get_hardware_info", "management", True),
        ("pci6208v_set_voltage", "hardware", False),
        ("get_hardware_info", "hardware", False),
    ],
)
async def test_only_platform_metadata_reads_bypass_active_call(
    tool_name: str,
    kind: str,
    allowed: bool,
) -> None:
    server_id = "PCI6208V_MCP"
    name = f"{server_id}__{tool_name}"
    execution = ExecutionCoordinator()
    handle = execution.acquire(
        {
            "state": "manual",
            "toolName": "write",
            "hardwareId": "H",
            "startedAt": "2026-09-15T00:00:00Z",
        }
    )
    service = Mock(
        list_tools=Mock(
            return_value=[
                {
                    "externalName": name,
                    "remoteName": tool_name,
                    "serverId": server_id,
                    "kind": kind,
                    "annotations": {"readOnlyHint": True},
                }
            ]
        ),
        list_servers=Mock(return_value=[{"serverId": server_id, "hardwareId": "H"}]),
        call_aggregated_tool=AsyncMock(return_value={"status": "running"}),
    )
    app = DevicesApplication(DefaultAuthorizer(), service, Mock(), execution)
    try:
        if allowed:
            assert await app.call_tool(CONTEXT, name, {}) == {"status": "running"}
            assert execution.current()["hardwareId"] == "H"
        else:
            with pytest.raises(AppError) as caught:
                await app.call_tool(CONTEXT, name, {})
            assert caught.value.category == "conflict"
            service.call_aggregated_tool.assert_not_called()
    finally:
        handle.release()


async def test_contract_discovery_obeys_authorization_and_exact_names() -> None:
    app = Mock(authorizer=DefaultAuthorizer(), devices=Mock(list_tools=Mock(return_value=[])))
    registry = ToolRegistry(app)
    result = await registry.invoke(CONTEXT, "get_tool_contract", {"query": "hardware", "limit": 1})
    assert result["data"]["hasMore"]
    name = result["data"]["items"][0]["name"]
    contract = await registry.invoke(CONTEXT, "get_tool_contract", {"toolName": name})
    assert contract["data"]["tool"]["name"] == name
    assert contract["data"]["referenceId"] == "hh-agent-interface"
    with pytest.raises(AppError, match="Unknown authorized"):
        await registry.invoke(CONTEXT, "get_tool_contract", {"toolName": "missing"})


@pytest.mark.parametrize(
    "upstream,value",
    [
        (
            {
                "type": "object",
                "properties": {
                    "value": {"type": "integer"},
                    "children": {"type": "array", "items": {"$ref": "#"}},
                },
                "required": ["value"],
            },
            {"value": 1, "children": [{"value": 2}]},
        ),
        (
            {
                "$id": "https://example.test/schema",
                "type": "object",
                "properties": {"ok": {"const": True}, "data": {"$ref": "#/definitions/Reading"}},
                "required": ["ok", "data"],
                "definitions": {
                    "Reading": {
                        "type": "object",
                        "properties": {"value": {"type": "number"}},
                        "required": ["value"],
                    }
                },
            },
            {"value": 3.3},
        ),
        (
            {
                "type": "object",
                "properties": {"ok": {"const": True}, "data": {"$ref": "#reading"}},
                "required": ["ok", "data"],
                "$defs": {"Reading": {"$anchor": "reading", "type": "integer"}},
            },
            3,
        ),
    ],
)
def test_nested_reference_documents_survive_gateway_sdk_and_error_schemas(
    upstream: Json, value: Any
) -> None:
    success = normalized_output_schema(upstream)
    public = with_error_schema(success)
    validator = Draft202012Validator(public)
    validator.validate({"ok": True, "data": value})
    error = {
        "ok": False,
        "error": {
            "category": "conflict",
            "message": "Changed",
            "details": {"hash": "abc"},
            "validationIssues": [{"path": ["expectedHash"]}],
        },
    }
    validator.validate(error)
    assert not validator.is_valid({"ok": True, "error": error["error"]})
    assert not validator.is_valid({"ok": False, "data": value})


def test_root_reference_to_union_and_optional_data_are_preserved() -> None:
    upstream = {
        "$ref": "#/$defs/Response",
        "$defs": {
            "Response": {
                "oneOf": [
                    {"type": "object", "properties": {"ok": {"const": False}}, "required": ["ok"]},
                    {
                        "type": "object",
                        "properties": {"ok": {"const": True}, "data": {"type": "integer"}},
                        "required": ["ok"],
                    },
                ]
            }
        },
    }
    validator = Draft202012Validator(normalized_output_schema(upstream))
    validator.validate({"ok": True, "data": 3})
    validator.validate({"ok": True, "data": {"ok": True}})
    assert not validator.is_valid({"ok": True, "data": {"ok": False}})
    # SDK does not unwrap plain untagged data dictionaries, while the gateway does.
    plain = {"type": "object", "properties": {"data": {"type": "integer"}}, "required": ["data"]}
    Draft202012Validator(normalized_output_schema(plain)).validate({"ok": True, "data": 2})


async def test_registry_context_and_structured_endpoints(tmp_path: Path) -> None:
    from .test_gateway import application

    app, devices, wiring = application()
    app.projects.projects.current.return_value = {
        "rootPath": str(tmp_path),
        "path": str(tmp_path / "project.json"),
        "dirty": False,
    }
    registry = ToolRegistry(app)
    context = await registry.invoke(CONTEXT, "get_agent_context", {})
    assert len(context["data"]["catalogRevision"]) == 64
    schema = next(t for t in registry.list(CONTEXT) if t["name"] == "get_agent_context")[
        "outputSchema"
    ]
    Draft202012Validator(schema).validate(context)
    await registry.invoke(
        CONTEXT,
        "request_wiring_task",
        {
            "portA": {"hardwareId": "H", "portId": "H.P1"},
            "portB": "H.H.P2",
            "action": "connect",
        },
    )
    assert wiring.request_task.call_args.args[0]["portA"] == "H.H.P1"


async def test_all_public_builtin_schemas_allow_recoverable_errors() -> None:
    from .test_gateway import application

    app, _, _ = application()
    registry = ToolRegistry(app)
    error = {
        "ok": False,
        "error": {"category": "conflict", "message": "Hash changed", "details": {"hash": "new"}},
    }
    for tool in registry.list_builtin(CONTEXT):
        Draft202012Validator(tool["outputSchema"]).validate(error)


async def test_listed_result_schemas_are_objects_mcp_clients_accept() -> None:
    """The MCP SDK validates ``outputSchema.properties`` as objects; ``true`` is rejected."""
    from .test_gateway import application

    app, _, _ = application()
    for tool in ToolRegistry(app).list_builtin(CONTEXT):
        properties = tool["outputSchema"].get("properties", {})
        assert all(isinstance(value, dict) for value in properties.values()), tool["name"]
