from __future__ import annotations

from typing import Any, cast
from unittest.mock import AsyncMock, Mock, patch

import pytest

from testforge_backend.devices import DeviceService


def service_fixture() -> tuple[DeviceService, dict[str, Any]]:
    computer = {"id": "C", "address": "host", "ssh": {"shell": "posix"}}
    server = {
        "serverId": "S",
        "computerId": "C",
        "hardwareId": "H",
        "lifecycle": {
            "startCommand": "start",
            "stopCommand": "stop",
            "statusCommand": "status",
            "logPath": "/logs",
        },
    }
    store = Mock(
        get_computer=Mock(return_value=computer),
        get_server=Mock(return_value=server),
        list_computers=Mock(return_value=[computer]),
        list_servers=Mock(return_value=[server]),
        remove_server=AsyncMock(),
        remove_computer=AsyncMock(),
    )
    transports = Mock(
        connect=AsyncMock(return_value={}),
        disconnect=AsyncMock(),
        prepare_shutdown=AsyncMock(),
        list_hardware=AsyncMock(return_value=[]),
        list_tools=Mock(return_value=[]),
        call_tool=AsyncMock(return_value={"value": 3}),
    )
    service = DeviceService(store, Mock(remove=AsyncMock()), transports)
    service.ssh = Mock(
        execute=AsyncMock(
            return_value={"stdout": "", "stderr": "", "exitCode": 0, "truncated": False}
        ),
        disconnect=AsyncMock(),
        close=AsyncMock(),
    )
    service.occupancy = Mock(
        refresh=AsyncMock(),
        close=AsyncMock(),
        is_held=Mock(return_value=True),
        require_lease=Mock(return_value="L"),
    )
    return service, server


@pytest.mark.parametrize(
    "action,commands,prepared",
    [
        ("start", ["start"], False),
        ("stop", ["stop"], True),
        ("restart", ["stop", "start"], True),
        ("force-stop", ["stop"], False),
    ],
)
async def test_lifecycle_order(action: str, commands: list[str], prepared: bool) -> None:
    service, server = service_fixture()
    sequence: list[str] = []

    async def prepare(_server: Any) -> None:
        sequence.append("prepare")

    async def execute(_computer: str, command: str, timeout: int) -> dict[str, Any]:
        assert timeout == 90000
        sequence.append(command)
        return {"exitCode": 0, "stderr": ""}

    service.transports.prepare_shutdown.side_effect = prepare
    with (
        patch.object(service, "execute", side_effect=execute),
        patch.object(
            service, "refresh_server", AsyncMock(return_value={"transport": {"state": "online"}})
        ),
    ):
        await service.server_action("S", action)
    assert sequence == (["prepare"] if prepared else []) + commands
    if action in {"stop", "force-stop", "restart"}:
        service.transports.disconnect.assert_awaited_once_with("S")
    else:
        service.transports.disconnect.assert_not_awaited()
    assert all(call.args == (server,) for call in service.transports.connect.call_args_list)


async def test_safe_stop_failure_leaves_process_and_force_stop_bypasses_prepare() -> None:
    service, _ = service_fixture()
    service.transports.prepare_shutdown.side_effect = RuntimeError("hardware busy")
    with pytest.raises(Exception, match="was left running") as caught:
        await service.server_action("S", "stop")
    assert getattr(caught.value, "category", None) == "safe_stop_failed"
    service.ssh.execute.assert_not_awaited()
    service.transports.disconnect.assert_not_awaited()
    service.ssh.execute.return_value = {"exitCode": 1, "stderr": "denied"}
    with pytest.raises(RuntimeError, match="denied"):
        await service.server_action("S", "force-stop")
    service.transports.disconnect.assert_not_awaited()
    service.transports.prepare_shutdown.side_effect = None
    with pytest.raises(RuntimeError, match="denied"):
        await service.server_action("S", "restart")


async def test_start_retries_only_connection_twenty_times() -> None:
    service, _ = service_fixture()
    service.transports.connect.side_effect = RuntimeError("not ready")
    with (
        patch(
            "testforge_backend.devices.device_service.asyncio.sleep", new_callable=AsyncMock
        ) as sleep,
        pytest.raises(RuntimeError, match="not ready"),
    ):
        await service.server_action("S", "start")
    assert service.transports.connect.await_count == 20
    assert sleep.await_count == 20
    service.ssh.execute.assert_awaited_once()


async def test_computer_probe_status_logs_timeout_clamp_and_remove_cache() -> None:
    service, server = service_fixture()
    assert service.list_computers()[0]["id"] == "C"
    assert service.list_servers() == [server]
    assert (await service.refresh_computer("C"))["ssh"]["state"] == "online"
    service.ssh.execute.side_effect = RuntimeError("SSH down")
    assert (await service.refresh_computer("C"))["ssh"]["message"] == "Error: SSH down"
    assert service.list_statuses()[0]["ssh"]["state"] == "offline"
    service.ssh.execute.side_effect = None
    await service.execute("C", "run", 1)
    assert service.ssh.execute.call_args.args[2] == 1000
    await service.execute("C", "run", 999999)
    assert service.ssh.execute.call_args.args[2] == 300000
    service.ssh.execute.return_value = {"stdout": "first\r\n\nlast\n", "truncated": True}
    assert await service.read_server_logs("S", 99999) == {
        "lines": ["first", "last"],
        "truncated": True,
    }
    assert "2000" in service.ssh.execute.call_args.args[1]
    service._hardware = [{"hardwareId": "H", "serverId": "S"}, {"hardwareId": "X", "serverId": "T"}]
    service._server_statuses["S"] = {"serverId": "S"}
    await service.remove_server("S")
    assert service.list_hardware() == [{"hardwareId": "X", "serverId": "T"}]
    assert service.list_server_statuses() == []
    service.secrets.remove.assert_awaited_with("mcp:S")
    await service.remove_computer("C")
    assert service.list_statuses() == []
    service.secrets.remove.assert_awaited_with("ssh:C")
    assert await service.refresh_hardware() == []
    await service.close()
    cast(Mock, service.occupancy).close.assert_awaited_once()
    service.ssh.close.assert_awaited_once()


async def test_tool_lease_metadata_and_faulted_hardware_refresh() -> None:
    service, _ = service_fixture()
    hardware = {
        "hardwareId": "H",
        "serverId": "S",
        "state": "faulted",
        "lastError": {"message": "driver fault"},
    }
    service.transports.connect.return_value = {"hardware": hardware}
    assert (await service.refresh_server("S"))["transport"]["state"] == "online"
    assert service.list_availability()[0]["message"] == "driver fault"
    assert service.list_availability()[0]["state"] == "faulted"
    assert service.is_hardware_occupied("H")
    service.transports.list_tools.return_value = [
        {"externalName": "S__measure", "serverId": "S", "kind": "hardware"},
        {"externalName": "S__status", "serverId": "S", "kind": "service"},
    ]
    options: dict[str, Any] = {"timeoutMs": 500, "metadata": {"attempt": 2, "hardwareId": "WRONG"}}
    assert await service.call_tool("S__measure", {"channel": 1}, options) == {"value": 3}
    service.transports.call_tool.assert_awaited_with(
        "S__measure",
        {"channel": 1},
        {"timeoutMs": 500, "metadata": {"attempt": 2, "hardwareId": "H", "occupancyLeaseId": "L"}},
    )
    await service.call_tool("S__status", {})
    assert cast(Mock, service.occupancy).require_lease.call_count == 1
    assert options["metadata"]["hardwareId"] == "WRONG"
    with pytest.raises(RuntimeError, match="Unknown aggregated"):
        await service.call_tool("missing", {})
    service.store.get_computer.return_value = None
    with pytest.raises(RuntimeError, match="Remote computer not found"):
        await service.refresh_computer("missing")
