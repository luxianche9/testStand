from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from jsonschema import Draft202012Validator

from hardwareharness_backend.application import DefaultAuthorizer, ExecutionCoordinator
from hardwareharness_backend.application.services import DevicesApplication
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.devices.mcp_client import McpHttpTransport
from hardwareharness_backend.mcp_gateway.contract_tools import import_firmware
from hardwareharness_backend.mcp_gateway.public_contracts import (
    normalized_output_schema,
    public_remote_tool,
    sdk_data_schema,
    sdk_envelope_schema,
    with_error_schema,
)
from hardwareharness_backend.mcp_gateway.tool_registry import BUILTIN_TOOL_DEFINITIONS, ToolRegistry

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
    for definition in BUILTIN_TOOL_DEFINITIONS:
        tool = definition.tool
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
    envelope = {
        "content": [{"type": "image", "mimeType": "image/png", "data": "YQ=="}],
        "structuredContent": {"ok": True, "data": {"volts": 1.2}},
        "isError": False,
    }
    Draft202012Validator(sdk_envelope_schema(upstream)).validate(envelope)
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
    assert tool["_meta"]["hardwareharness"]["sdkToolName"] == "S__read"
    assert tool["_meta"]["hardwareharness"]["remoteToolName"] == "read"


async def test_error_only_remote_result_cannot_be_reported_as_success() -> None:
    transport = McpHttpTransport(Mock())
    transport.sessions["S"] = {
        "validators": {},
        "client": Mock(
            call_tool=AsyncMock(
                return_value={
                    "isError": True,
                    "content": [{"type": "text", "text": "driver refused"}],
                }
            )
        ),
    }
    for options in ({}, {"preserveEnvelope": True}):
        with pytest.raises(AppError, match="driver refused") as caught:
            await transport.call_remote("S", "write", {}, options)
        assert caught.value.details["automaticRetry"] is False


@pytest.mark.parametrize(
    "server_id,tool_name,allowed",
    [
        ("FIREDAP_MCP", "firedap_get_job", True),
        ("FIREDAP_MCP", "firedap_wait_job", True),
        ("PCI6208V_MCP", "get_hardware_info", True),
        ("PCI6208V_MCP", "pci6208v_set_voltage", False),
        ("THIRD_PARTY", "get_hardware_info", False),
    ],
)
async def test_only_platform_metadata_reads_bypass_active_run(
    server_id: str,
    tool_name: str,
    allowed: bool,
) -> None:
    name = f"{server_id}__{tool_name}"
    execution = ExecutionCoordinator()
    handle = execution.acquire(
        {"state": "run", "runId": "R", "hardwareIds": ["H"], "startedAt": "2026-09-15T00:00:00Z"}
    )
    service = Mock(
        list_tools=Mock(
            return_value=[
                {
                    "externalName": name,
                    "remoteName": tool_name,
                    "serverId": server_id,
                    "kind": "management",
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
            assert execution.current()["runId"] == "R"
        else:
            with pytest.raises(AppError) as caught:
                await app.call_tool(CONTEXT, name, {})
            assert caught.value.category == "conflict"
            service.call_aggregated_tool.assert_not_called()
    finally:
        handle.release()


async def test_firmware_transfer_does_not_require_large_model_payload(tmp_path: Path) -> None:
    data = b"FIRMWARE" * 150000
    (tmp_path / "image.bin").write_bytes(data)
    name = "FIREDAP_MCP__firedap_import_firmware"
    app = Mock(
        projects=Mock(document=Mock(return_value={"rootPath": str(tmp_path)})),
        devices=Mock(
            list_tools=Mock(return_value=[{"externalName": name}]),
            call_tool=AsyncMock(return_value={"artifactId": "sha256-id"}),
        ),
    )
    digest = hashlib.sha256(data).hexdigest()
    value = {"serverId": "FIREDAP_MCP", "path": "image.bin", "expectedSha256": digest}
    assert await import_firmware(app, CONTEXT, value) == {"artifactId": "sha256-id"}
    sent = app.devices.call_tool.call_args.args[2]
    assert base64.b64decode(sent["content_base64"]) == data
    assert sent["expected_sha256"] == digest
    app.devices.call_tool.reset_mock()
    for change in (
        {"expectedSha256": "0" * 64},
        {"path": str(tmp_path / "image.bin")},
        {"path": "../outside.bin"},
    ):
        with pytest.raises(AppError):
            await import_firmware(app, CONTEXT, {**value, **change})
    app.devices.call_tool.assert_not_called()


async def test_contract_discovery_obeys_authorization_and_exact_names() -> None:
    app = Mock(authorizer=DefaultAuthorizer(), devices=Mock(list_tools=Mock(return_value=[])))
    registry = ToolRegistry(app)
    result = await registry.invoke(CONTEXT, "get_tool_contract", {"query": "workspace", "limit": 1})
    assert result["data"]["hasMore"]
    name = result["data"]["items"][0]["name"]
    contract = await registry.invoke(CONTEXT, "get_tool_contract", {"toolName": name})
    assert contract["data"]["tool"]["name"] == name
    assert contract["data"]["referenceId"] == "hh-sdk"
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
    structured = {"ok": True, "data": value} if "ok" in upstream.get("properties", {}) else value
    envelope: Json = {"content": [], "structuredContent": structured, "isError": False}
    Draft202012Validator(sdk_envelope_schema(upstream)).validate(envelope)
    Draft202012Validator(sdk_data_schema(upstream)).validate(value)


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
    Draft202012Validator(sdk_data_schema(plain)).validate({"data": 2})
    Draft202012Validator(normalized_output_schema(plain)).validate({"ok": True, "data": 2})


async def test_contract_sdk_name_can_be_called_through_actual_application(tmp_path: Path) -> None:
    from ..application.test_applications import fixture

    applications, service = await fixture(tmp_path)
    service.list_tools.return_value[0].update(remoteName="call", inputSchema={"type": "object"})
    app = Mock(
        authorizer=DefaultAuthorizer(),
        devices=Mock(list_tools=Mock(side_effect=lambda context: service.list_tools())),
    )
    contract = await ToolRegistry(app).invoke(CONTEXT, "get_tool_contract", {"toolName": "S__call"})
    sdk_name = contract["data"]["sdk"]["toolName"]
    assert sdk_name == "S__call" and "'S__call'" in contract["data"]["sdk"]["example"]
    await applications._invoke("H", sdk_name, {}, 1000)
    service.call_tool.assert_awaited_once()
    await applications.close()


async def test_registry_context_structured_endpoints_and_firmware_execute(tmp_path: Path) -> None:
    from .test_gateway import application

    app, devices, wiring, _ = application()
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
    devices.list_tools.return_value = [
        {
            "externalName": "S1__firedap_import_firmware",
            "remoteName": "firedap_import_firmware",
            "serverId": "S1",
            "kind": "management",
            "inputSchema": {},
        }
    ]
    devices.call_aggregated_tool = AsyncMock(
        return_value={
            "artifactId": "id",
            "path": "managed/id.bin",
            "sha256": "0" * 64,
            "fileBytes": 1,
        }
    )
    (tmp_path / "image.bin").write_bytes(b"x")
    imported = await registry.invoke(
        CONTEXT, "import_firmware_artifact", {"serverId": "S1", "path": "image.bin"}
    )
    assert imported["data"]["artifactId"] == "id"
    devices.call_aggregated_tool.assert_awaited_once()


async def test_all_public_builtin_schemas_allow_recoverable_errors_and_interrupted_runs() -> None:
    from .test_gateway import application

    app, _, _, runner = application()
    registry = ToolRegistry(app)
    error = {
        "ok": False,
        "error": {"category": "conflict", "message": "Hash changed", "details": {"hash": "new"}},
    }
    for tool in registry.list_builtin(CONTEXT):
        Draft202012Validator(tool["outputSchema"]).validate(error)
    runner.list_runs = AsyncMock(return_value=[{"runId": "R", "status": "interrupted"}])
    result = await registry.invoke(CONTEXT, "list_python_runs", {"status": "interrupted"})
    tool = next(
        item for item in registry.list_builtin(CONTEXT) if item["name"] == "list_python_runs"
    )
    Draft202012Validator(tool["outputSchema"]).validate(result)
    assert runner.list_runs.call_args.args[0]["status"] == "interrupted"
