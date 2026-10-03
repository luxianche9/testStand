from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from teststand_backend.application import DefaultAuthorizer
from teststand_backend.contracts.validation import ValidationError
from teststand_backend.mcp_gateway.agent_services import AGENT_TOOLS

AGENT = {"actor": "agent", "source": "mcp"}
TOOLS = {tool.name: tool for tool in AGENT_TOOLS}


async def invoke(app: Any, name: str, value: Any = None) -> Any:
    tool = TOOLS[name]
    output = await tool.execute(app, AGENT, tool.parse(value or {}))
    definition = tool.definition()
    Draft202012Validator(definition["outputSchema"]).validate({"ok": True, "data": output})
    return output


def test_new_tool_contracts_have_descriptions_output_schemas_and_bounded_inputs() -> None:
    for item in AGENT_TOOLS:
        tool = item.definition()
        Draft202012Validator.check_schema(tool["inputSchema"])
        Draft202012Validator.check_schema(tool["outputSchema"])
        assert tool["annotations"]["destructiveHint"] is False
        assert all(prop.get("description") for prop in tool["inputSchema"]["properties"].values())
    with pytest.raises(ValidationError):
        TOOLS["wait_for_status"].parse({"kind": "run", "id": "R", "timeoutMs": 30001})


async def test_context_without_project_and_document_reads_use_only_bundled_contract() -> None:
    app = SimpleNamespace(
        projects=SimpleNamespace(document=lambda context: None), authorizer=DefaultAuthorizer()
    )
    context = await invoke(app, "get_agent_context")
    assert context["project"] is None
    assert context["contractRevision"] == "2026-09-16.2"
    assert context["references"][0]["referenceId"] == "ts-agent-interface"
    page = await invoke(
        app, "read_reference", {"referenceId": "ts-agent-interface", "query": "get_tool_contract"}
    )
    assert page["lines"]


async def test_effective_availability_accounts_for_holders_and_disabled_device() -> None:
    dashboard: dict[str, Any] = {
        "execution": {"state": "manual", "toolName": "write", "hardwareId": "H"},
        "availability": [{"hardwareId": "H", "state": "available", "checkedAt": "old"}],
        "devices": [{"deviceId": "S", "enabled": True}],
    }
    app = SimpleNamespace(
        system=SimpleNamespace(dashboard=lambda context: dashboard),
        devices=SimpleNamespace(
            list_hardware=lambda context: [{"hardwareId": "H", "kind": "managed", "deviceId": "S"}]
        ),
    )
    output = await invoke(app, "get_execution_availability")
    assert output["hardware"][0]["available"] is False
    assert output["hardware"][0]["holders"][0]["toolName"] == "write"
    dashboard["execution"] = {"state": "idle"}
    dashboard["devices"][0]["enabled"] = False
    output = await invoke(app, "get_execution_availability")
    assert output["hardware"][0]["busyReason"] == "device_disabled_or_missing"


async def test_wait_is_bounded_and_detects_existing_wiring_change() -> None:
    status = {"wiringTaskId": "W", "status": "pending"}
    app = SimpleNamespace(wiring=SimpleNamespace(get_task=lambda context, id: dict(status)))
    first = await invoke(app, "wait_for_status", {"kind": "wiring", "id": "W", "timeoutMs": 0})
    assert first["timedOut"] and not first["changed"]
    pending = asyncio.create_task(
        invoke(
            app,
            "wait_for_status",
            {"kind": "wiring", "id": "W", "revision": first["revision"], "timeoutMs": 500},
        )
    )
    await asyncio.sleep(0)
    status["status"] = "confirmed"
    done = await pending
    assert done["changed"] and done["terminal"] and not done["timedOut"]
