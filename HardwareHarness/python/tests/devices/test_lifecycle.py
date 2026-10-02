"""Lifecycle commands derive from the install root; overrides win; URL-added services have none."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from hardwareharness_backend.devices.lifecycle import (
    derived_lifecycle,
    is_managed,
    lifecycle_command,
    lifecycle_of,
)

from .test_service_boundaries import service_fixture

ROOT = r"E:\PCI1710L_MCP"


def test_commands_derive_from_the_root() -> None:
    assert derived_lifecycle(ROOT + "\\") == {
        "statusCommand": r"& 'E:\PCI1710L_MCP\status.ps1'",
        "startCommand": r"& 'E:\PCI1710L_MCP\start.ps1'",
        "stopCommand": r"& 'E:\PCI1710L_MCP\stop.ps1'",
        "forceStopCommand": r"& 'E:\PCI1710L_MCP\stop.ps1' -Force",
        "logPath": r"E:\PCI1710L_MCP\logs",
    }
    assert derived_lifecycle(r"C:\it's")["startCommand"] == r"& 'C:\it''s\start.ps1'"


def test_overrides_replace_single_commands() -> None:
    server = {"serverId": "S", "computerId": "C", "root": ROOT, "lifecycle": {"logPath": r"D:\l"}}
    effective = lifecycle_of(server)
    assert effective["logPath"] == r"D:\l"
    assert effective["startCommand"] == r"& 'E:\PCI1710L_MCP\start.ps1'"
    assert is_managed(server)


def test_a_stop_override_is_also_the_force_stop_without_a_root() -> None:
    server = {
        "serverId": "S",
        "computerId": "C",
        "lifecycle": {"statusCommand": "st", "startCommand": "go", "stopCommand": "halt"},
    }
    assert lifecycle_command(server, "forceStopCommand") == "halt"
    with pytest.raises(Exception, match="lifecycle.logPath") as caught:
        lifecycle_command(server, "logPath")
    assert getattr(caught.value, "category", None) == "invalid_argument"


def test_a_service_added_by_url_cannot_be_controlled() -> None:
    server = {"serverId": "S", "root": ROOT}
    assert not is_managed(server)
    with pytest.raises(Exception, match="added by URL") as caught:
        lifecycle_command(server, "startCommand")
    assert getattr(caught.value, "category", None) == "unavailable"


async def test_force_stop_runs_the_derived_force_command() -> None:
    service, server = service_fixture()
    server.pop("lifecycle")
    server["root"] = ROOT
    commands: list[str] = []

    async def execute(_computer: str, command: str, _timeout: int) -> dict[str, object]:
        commands.append(command)
        return {"exitCode": 0, "stderr": ""}

    with (
        patch.object(service, "execute", side_effect=execute),
        patch.object(service, "refresh_server", AsyncMock(return_value={})),
    ):
        await service.server_action("S", "force-stop")
    assert commands == [r"& 'E:\PCI1710L_MCP\stop.ps1' -Force"]
    service.transports.prepare_shutdown.assert_not_awaited()
