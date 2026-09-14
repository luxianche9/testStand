from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from testforge_backend.contracts.devices import (
    parse_remote_computer,
    reported_managed_hardware_schema,
)
from testforge_backend.contracts.validation import ValidationError
from testforge_backend.devices.local_shell import execute_local_shell

from .test_devices import fixture, hardware, server, transport


@pytest.mark.parametrize("kind", ["computer", "server"])
async def test_concurrent_probes_preserve_last_result_and_share_work(
    tmp_path: Path, kind: str
) -> None:
    service = await fixture(tmp_path, "none", result={"exitCode": 0, "stdout": "", "stderr": ""})
    probe = service.refresh_computer if kind == "computer" else service.refresh_server
    identifier = "PC1" if kind == "computer" else "PCI1762_MCP"
    statuses = service.list_statuses if kind == "computer" else service.list_server_statuses
    field = "ssh" if kind == "computer" else "transport"
    previous = await probe(identifier)
    original = service.execute if kind == "computer" else service.transports.connect
    started = asyncio.Event()
    pending: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

    async def fail_probe(*args: Any) -> dict[str, Any]:
        started.set()
        return await pending

    mocked = AsyncMock(side_effect=fail_probe)
    if kind == "computer":
        service.execute = mocked  # type: ignore[method-assign]
    else:
        service.transports.connect = mocked
    first = asyncio.create_task(probe(identifier))
    await started.wait()
    second = asyncio.create_task(probe(identifier))
    await asyncio.sleep(0)
    assert statuses() == [previous]
    assert previous[field]["state"] == "online"
    assert mocked.await_count == 1
    pending.set_exception(RuntimeError("Connection lost"))
    failed, shared = await asyncio.gather(first, second)
    assert failed is shared
    assert failed[field]["state"] == "offline"
    assert statuses() == [failed]
    assert previous[field]["state"] == "online"
    if kind == "computer":
        service.execute = original  # type: ignore[method-assign]
    else:
        service.transports.connect = original
    assert (await probe(identifier))[field]["state"] == "online"


@pytest.mark.parametrize("stop_code,start_code", [(0, 0), (1, 0), (0, 1)])
async def test_restart_disconnects_only_after_successful_stop(
    tmp_path: Path, stop_code: int, start_code: int
) -> None:
    service = await fixture(tmp_path, "none", shell="posix")
    events: list[str] = []

    async def connect(*args: Any) -> dict[str, Any]:
        events.append("connect")
        return {}

    async def disconnect(*args: Any) -> None:
        events.append("disconnect")

    async def shutdown(*args: Any) -> None:
        events.append("safe-stop")

    async def execute(computer: Any, command: str, timeout: int) -> dict[str, Any]:
        action = "stop" if "stop.sh" in command else "start"
        events.append(action)
        return {
            "stdout": "",
            "stderr": "failure",
            "exitCode": stop_code if action == "stop" else start_code,
        }

    service.transports.connect = connect
    service.transports.disconnect = disconnect
    service.transports.prepare_shutdown = shutdown
    service.ssh.execute = execute
    if stop_code or start_code:
        with pytest.raises(RuntimeError, match="failure"):
            await service.server_action("PCI1762_MCP", "restart")
    else:
        await service.server_action("PCI1762_MCP", "restart")
    expected = ["connect", "safe-stop", "stop"]
    if not stop_code:
        expected += ["disconnect", "start"]
        if not start_code:
            expected += ["connect"]
    assert events[: len(expected)] == expected
    if stop_code or start_code:
        assert events == expected


@pytest.mark.parametrize(
    "at", ["2026-09-10T07:40:00.123456+00:00", "2026-09-10T15:40:00+08:00", "2026-09-10T07:40:00Z"]
)
async def test_hardware_error_accepts_explicit_offsets(at: str) -> None:
    error = {"category": "device_error", "message": "Board initialization failed", "at": at}
    result = reported_managed_hardware_schema.parse(
        {"hardwareId": "H", "state": "faulted", "health": "failed", "lastError": error}
    )
    assert result["lastError"] == error
    remote = await transport(
        [{**hardware(), "state": "faulted", "lastError": error}]
    )._refresh_single_hardware({"server": server()})
    assert remote["lastError"] == error
    assert remote["state"] == "faulted" and remote["hardwareId"] == server()["hardwareId"]


@pytest.mark.parametrize("at", ["not-a-date", "2026-09-10T07:40:00", "2026-02-30T07:40:00+00:00"])
async def test_hardware_error_rejects_invalid_or_ambiguous_timestamp(at: str) -> None:
    with pytest.raises(ValidationError):
        reported_managed_hardware_schema.parse(
            {
                "hardwareId": "H",
                "state": "faulted",
                "health": "failed",
                "lastError": {"category": "error", "message": "failed", "at": at},
            }
        )

    with pytest.raises(ValidationError):
        await transport(
            [{**hardware(), "lastError": {"category": "error", "message": "failed", "at": at}}]
        )._refresh_single_hardware({"server": server()})


def test_local_computer_is_explicit_and_loopback_only() -> None:
    computer = {"id": "PC", "label": "PC", "address": "192.168.1.4", "ssh": {"username": "user"}}
    assert "execution" not in parse_remote_computer(computer)
    with pytest.raises(ValidationError, match="loopback"):
        parse_remote_computer({**computer, "execution": "local"})
    for address in ("127.0.0.1", "localhost", "::1"):
        assert (
            parse_remote_computer({**computer, "execution": "local", "address": address})[
                "execution"
            ]
            == "local"
        )


async def test_local_shell_output_nonzero_timeout_and_buffer_limit() -> None:
    shell = "powershell" if sys.platform == "win32" else "posix"
    result = await execute_local_shell(shell, "echo local-ready; exit 7", 10000)
    assert result["stdout"].strip() == "local-ready"
    assert result["exitCode"] == 7 and result["truncated"] is False
    with pytest.raises(TimeoutError):
        await execute_local_shell(
            shell, "Start-Sleep 10" if shell == "powershell" else "sleep 10", 200
        )
    with pytest.raises(RuntimeError, match="maxBuffer"):
        await execute_local_shell(
            shell,
            "Write-Output ('x' * 2097153)"
            if shell == "powershell"
            else "head -c 2097153 /dev/zero",
            10000,
        )


async def test_local_execution_avoids_ssh_and_failed_probe_is_offline(tmp_path: Path) -> None:
    service = await fixture(tmp_path, "none")
    shell = "powershell" if sys.platform == "win32" else "posix"
    await service.save_computer(
        {
            "id": "PC1",
            "label": "Local",
            "address": "127.0.0.1",
            "execution": "local",
            "ssh": {"username": "local", "shell": shell},
        }
    )
    assert (await service.execute("PC1", "echo local-ready"))["stdout"].strip() == "local-ready"
    assert (await service.refresh_computer("PC1"))["ssh"]["state"] == "online"
    service.ssh.execute.assert_not_awaited()
    service.execute = AsyncMock(return_value={"exitCode": 3, "stderr": "probe failed"})  # type: ignore[method-assign]
    assert (await service.refresh_computer("PC1"))["ssh"]["state"] == "offline"
