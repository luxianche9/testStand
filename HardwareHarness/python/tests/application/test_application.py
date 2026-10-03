from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.application import (
    AGENT_REQUEST_CONTEXT as AGENT,
)
from hardwareharness_backend.application import (
    HUMAN_REQUEST_CONTEXT as HUMAN,
)
from hardwareharness_backend.application import (
    DefaultAuthorizer,
    ExecutionCoordinator,
    HardwareHarnessApplication,
    ManualControlApplication,
)
from hardwareharness_backend.contracts.agents import CAPABILITIES

Json = dict[str, Any]
AGENT_ALLOWED = {
    "system.read",
    "devices.read",
    "devices.controlServers",
    "hardware.read",
    "hardware.manage",
    "hardware.executeTools",
    "projects.read",
    "projects.manage",
    "wiring.read",
    "wiring.request",
    "references.read",
    "references.manage",
    "testing.read",
    "testing.manage",
    "testing.execute",
}
HARDWARE: Json = {
    "formatVersion": 2,
    "hardwareId": "HW1",
    "label": "Fixture card",
    "kind": "managed",
    "serverId": "SERVER1",
    "computerId": "PC1",
    "ports": [],
}
TOOL: Json = {
    "externalName": "SERVER1__write_value",
    "remoteName": "write_value",
    "serverId": "SERVER1",
    "inputSchema": {
        "type": "object",
        "properties": {"hardwareId": {"type": "string"}, "value": {"type": "number"}},
        "required": ["hardwareId", "value"],
    },
    "kind": "hardware",
}


def make_app() -> tuple[HardwareHarnessApplication, Mock, Mock]:
    devices = Mock(
        save_computer=AsyncMock(),
        remove_server=AsyncMock(),
        execute=AsyncMock(),
        server_action=AsyncMock(),
        call_aggregated_tool=AsyncMock(return_value="ok"),
    )
    devices.list_tools.return_value = [
        {"externalName": "S1.measure", "serverId": "S1", "kind": "hardware"}
    ]
    devices.list_servers.return_value = [{"serverId": "S1", "hardwareId": "H1", "enabled": True}]
    wiring = Mock(request_task=AsyncMock(), start_task=AsyncMock())
    app = HardwareHarnessApplication(
        {
            "devices": devices,
            "catalog": Mock(),
            "projects": Mock(),
            "wiring": wiring,
            "system": Mock(),
        }
    )
    return app, devices, wiring


@pytest.mark.ts_case(
    "packages/application/src/application.test.ts::implements the complete "
    "default Agent capability matrix"
)
def test_capability_matrix() -> None:
    authorizer = DefaultAuthorizer()
    assert {cap: authorizer.is_allowed(AGENT, cap) for cap in CAPABILITIES} == {
        cap: cap in AGENT_ALLOWED for cap in CAPABILITIES
    }
    assert authorizer.allowed_capabilities(HUMAN) == list(CAPABILITIES)


@pytest.mark.ts_case(
    "packages/application/src/application.test.ts::allows Agent tests, hardware "
    "tools and wiring requests"
)
async def test_agent_allowed() -> None:
    app, devices, wiring = make_app()
    await app.wiring.request_task(
        AGENT, {"portA": "A.J1", "portB": "B.J1", "action": "connect", "pins": []}
    )
    await app.devices.call_tool(AGENT, "S1.measure", {})
    assert wiring.request_task.call_args.args[0]["requestedBy"] == "agent"
    devices.call_aggregated_tool.assert_called_once_with("S1.measure", {})


@pytest.mark.ts_case(
    "packages/application/src/application.test.ts::denies Agent computer/server "
    "management, arbitrary SSH, force-stop and human confirmations"
)
async def test_agent_denied() -> None:
    app, devices, wiring = make_app()
    operations = [
        app.devices.save_computer(AGENT, {"id": "PC1"}),
        app.devices.remove_server(AGENT, "S1"),
        app.devices.execute_ssh(AGENT, "PC1", "whoami"),
        app.devices.server_action(AGENT, "S1", "force-stop"),
        app.wiring.start_task(AGENT, "WT"),
    ]
    for operation in operations:
        with pytest.raises(Exception) as caught:
            await operation
        assert getattr(caught.value, "category", None) == "permission_denied"
    devices.save_computer.assert_not_called()
    devices.execute.assert_not_called()
    wiring.start_task.assert_not_called()


@pytest.mark.ts_case(
    "packages/application/src/application.test.ts::allows humans to manage "
    "infrastructure and confirm operator work"
)
async def test_human_allowed() -> None:
    app, devices, wiring = make_app()
    await app.devices.save_computer(
        HUMAN,
        {
            "id": "PC1",
            "label": "Lab",
            "address": "10.0.0.2",
            "ssh": {"port": 22, "username": "u", "shell": "powershell"},
        },
    )
    await app.devices.server_action(HUMAN, "S1", "force-stop")
    await app.wiring.start_task(HUMAN, "WT", "operator")
    devices.save_computer.assert_called_once()
    wiring.start_task.assert_called_once_with("WT", "operator")


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::allows disjoint activities "
    "and publishes a complete aggregate activity"
)
def test_disjoint_hardware_activities() -> None:
    execution = ExecutionCoordinator()
    states: list[str] = []
    execution.set_notifier(lambda activity: states.append(activity["state"]))
    manual = execution.acquire(
        {
            "state": "manual",
            "hardwareId": "HW2",
            "toolName": "write",
            "startedAt": "2026-08-15T00:00:00.000Z",
        }
    )
    run = execution.acquire(
        {
            "state": "manual",
            "toolName": "write",
            "hardwareId": "HW1",
            "startedAt": "2026-08-15T00:00:01.000Z",
        }
    )
    current = execution.current()
    assert current["state"] == "manual" and current["hardwareId"] == "HW2"
    assert [
        (item["state"], item.get("hardwareId"), item.get("hardwareIds"))
        for item in current["activities"]
    ] == [("manual", "HW2", None), ("manual", "HW1", None)]
    run.release()
    manual.release()
    manual.release()
    assert execution.current() == {"state": "idle"}
    assert states == ["manual", "manual", "manual", "idle"]


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::acquires multiple hardware keys atomically"
)
def test_atomic_acquire() -> None:
    execution = ExecutionCoordinator()
    hw2 = execution.acquire(
        {
            "state": "manual",
            "hardwareId": "HW2",
            "toolName": "write",
            "startedAt": "2026-08-15T00:00:00.000Z",
        }
    )
    with pytest.raises(Exception) as caught:
        execution.acquire(
            {
                "state": "manual",
                "toolName": "write",
                "hardwareId": "HW2",
                "startedAt": "2026-08-15T00:00:01.000Z",
            }
        )
    assert getattr(caught.value, "category", None) == "conflict"
    assert getattr(caught.value, "details", {})["hardwareIds"] == ["HW2"]
    hw1 = execution.acquire(
        {
            "state": "manual",
            "hardwareId": "HW1",
            "toolName": "read",
            "startedAt": "2026-08-15T00:00:02.000Z",
        }
    )
    hw1.release()
    hw2.release()
    assert execution.current() == {"state": "idle"}


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::keeps newer holders "
    "safe from stale and idempotent releases"
)
def test_stale_release() -> None:
    execution = ExecutionCoordinator()
    old = execution.acquire(
        {
            "state": "manual",
            "toolName": "write",
            "hardwareId": "HW1",
            "startedAt": "2026-08-15T00:00:00.000Z",
        }
    )
    old.release()
    current = execution.acquire(
        {
            "state": "manual",
            "hardwareId": "HW1",
            "toolName": "write",
            "startedAt": "2026-08-15T00:00:01.000Z",
        }
    )
    old.release()
    assert execution.current()["state"] == "manual" and execution.current()["hardwareId"] == "HW1"
    current.release()
    assert execution.current() == {"state": "idle"}


def manual_fixture(
    **overrides: Any,
) -> tuple[ManualControlApplication, ExecutionCoordinator, AsyncMock]:
    call = overrides.get("call", AsyncMock(return_value={"accepted": True}))
    devices = Mock(
        list_tools=Mock(return_value=overrides.get("tools", [TOOL])),
        list_availability=Mock(
            return_value=overrides.get(
                "availability",
                [
                    {
                        "hardwareId": "HW1",
                        "state": "available",
                        "checkedAt": "2026-01-01T00:00:00.000Z",
                    }
                ],
            )
        ),
        call_tool=call,
    )
    catalog = Mock(get_hardware=Mock(return_value=overrides.get("hardware", HARDWARE)))
    execution = ExecutionCoordinator()
    return (
        ManualControlApplication(DefaultAuthorizer(), devices, catalog, execution),
        execution,
        call,
    )


def invocation(**extra: Any) -> Json:
    return {
        "hardwareId": "HW1",
        "toolName": TOOL["externalName"],
        "arguments": {"value": 1},
        **extra,
    }


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::injects the selected "
    "hardwareId, applies the default timeout and returns timing metadata"
)
async def test_manual_metadata() -> None:
    manual, _, call = manual_fixture()
    result = await manual.invoke_tool(
        HUMAN, invocation(arguments={"hardwareId": "spoofed", "value": 3.5})
    )
    name, args, options = call.call_args.args
    assert name == TOOL["externalName"] and args == {"hardwareId": "spoofed", "value": 3.5}
    assert options["timeoutMs"] == 30000 and options["metadata"] == {"hardwareId": "HW1"}
    assert hasattr(options["signal"], "aborted")
    assert (
        result["hardwareId"] == "HW1"
        and result["toolName"] == TOOL["externalName"]
        and result["output"] == {"accepted": True}
    )
    assert result["durationMs"] >= 0 and result["completedAt"] >= result["startedAt"]


@pytest.mark.parametrize(
    ("overrides", "category"),
    [
        pytest.param(
            {"hardware": {**HARDWARE, "kind": "passive", "serverId": None, "computerId": None}},
            "invalid_argument",
            marks=pytest.mark.ts_case(
                "packages/application/src/execution-control.test.ts::rejects passive hardware"
            ),
        ),
        pytest.param(
            {"tools": []},
            "unavailable",
            marks=pytest.mark.ts_case(
                "packages/application/src/execution-control.test.ts::rejects unknown tool"
            ),
        ),
        pytest.param(
            {"tools": [{**TOOL, "serverId": "SERVER2"}]},
            "invalid_argument",
            marks=pytest.mark.ts_case(
                "packages/application/src/execution-control.test.ts::rejects tool from "
                "another Server"
            ),
        ),
        pytest.param(
            {"availability": []},
            "unavailable",
            marks=pytest.mark.ts_case(
                "packages/application/src/execution-control.test.ts::rejects missing availability"
            ),
        ),
        pytest.param(
            {
                "availability": [
                    {
                        "hardwareId": "HW1",
                        "state": "unavailable",
                        "checkedAt": "2026-01-01T00:00:00.000Z",
                    }
                ]
            },
            "unavailable",
            marks=pytest.mark.ts_case(
                "packages/application/src/execution-control.test.ts::rejects offline hardware"
            ),
        ),
    ],
)
async def test_manual_invalid(overrides: Json, category: str) -> None:
    manual, _, call = manual_fixture(**overrides)
    with pytest.raises(Exception) as caught:
        await manual.invoke_tool(HUMAN, invocation())
    assert getattr(caught.value, "category", None) == category
    call.assert_not_called()


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::allows non-hardware MCP "
    "tools without requiring hardware availability"
)
async def test_management_tool_offline() -> None:
    tool = {
        **TOOL,
        "externalName": "SERVER1__list_hardware",
        "remoteName": "list_hardware",
        "kind": "management",
    }
    manual, _, call = manual_fixture(
        tools=[tool], availability=[{"hardwareId": "HW1", "state": "unavailable"}]
    )
    result = await manual.invoke_tool(
        HUMAN, invocation(toolName=tool["externalName"], arguments={})
    )
    assert call.call_args.args[0] == tool["externalName"] and call.call_args.args[1] == {}
    assert call.call_args.args[2]["timeoutMs"] == 30000 and call.call_args.args[2]["metadata"] == {
        "hardwareId": "HW1"
    }
    assert result["hardwareId"] == "HW1" and result["toolName"] == tool["externalName"]


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::releases its hardware after a remote error"
)
async def test_manual_remote_error() -> None:
    error = Exception("remote rejected")
    manual, execution, _ = manual_fixture(call=AsyncMock(side_effect=error))
    with pytest.raises(Exception) as caught:
        await manual.invoke_tool(HUMAN, invocation())
    assert caught.value is error and execution.current() == {"state": "idle"}


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::conflicts only with "
    "Runs that need the same hardware and aborts the call during shutdown"
)
async def test_manual_shutdown() -> None:
    async def call(name: str, args: Json, options: Json) -> None:
        await options["signal"].wait()
        raise options["signal"].reason

    manual, execution, _ = manual_fixture(call=AsyncMock(side_effect=call))
    pending = asyncio.create_task(manual.invoke_tool(HUMAN, invocation()))
    await asyncio.sleep(0)
    assert execution.current()["state"] == "manual"
    disjoint = execution.acquire(
        {
            "state": "manual",
            "toolName": "write",
            "hardwareId": "HW2",
            "startedAt": "2026-01-01T00:00:00.000Z",
        }
    )
    with pytest.raises(Exception) as caught:
        execution.acquire(
            {
                "state": "manual",
                "toolName": "write",
                "hardwareId": "HW1",
                "startedAt": "2026-01-01T00:00:00.000Z",
            }
        )
    assert getattr(caught.value, "category", None) == "conflict"
    disjoint.release()
    await manual.close()
    with pytest.raises(Exception) as aborted:
        await pending
    assert getattr(aborted.value, "name", None) == "AbortError"
    assert execution.current() == {"state": "idle"}


@pytest.mark.ts_case(
    "packages/application/src/execution-control.test.ts::rejects a valid manual "
    "call while a Run is active"
)
async def test_concurrent_call_blocks_manual() -> None:
    manual, execution, call = manual_fixture()
    active = execution.acquire(
        {
            "state": "manual",
            "toolName": "write",
            "hardwareId": "HW1",
            "startedAt": "2026-01-01T00:00:00.000Z",
        }
    )
    with pytest.raises(Exception) as caught:
        await manual.invoke_tool(HUMAN, invocation())
    assert getattr(caught.value, "category", None) == "conflict"
    call.assert_not_called()
    active.release()
