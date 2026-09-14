import pytest

from hardwareharness_backend.contracts.devices import (
    parse_hardware,
    parse_managed_hardware,
    parse_mcp_server,
    parse_remote_computer,
)
from hardwareharness_backend.contracts.errors import app_error, to_wire_error
from hardwareharness_backend.contracts.projects import parse_project_file
from hardwareharness_backend.contracts.validation import ValidationError, parse_id_input

PREFIX = "packages/contracts/src/contracts.test.ts::public contracts::"


@pytest.mark.ts_case(PREFIX + "rejects passive hardware that references remote infrastructure")
def test_passive_references() -> None:
    with pytest.raises(ValidationError):
        parse_hardware(
            {
                "formatVersion": 2,
                "hardwareId": "DUT",
                "label": "DUT",
                "kind": "passive",
                "serverId": "S1",
                "computerId": "PC1",
                "ports": [],
            }
        )


@pytest.mark.ts_case(PREFIX + "applies stable defaults")
def test_defaults() -> None:
    computer = parse_remote_computer(
        {"id": "PC1", "label": "PC", "address": "127.0.0.1", "ssh": {"username": "user"}}
    )
    assert computer["ssh"] == {"port": 22, "username": "user", "shell": "powershell"}
    assert (
        parse_mcp_server(
            {
                "serverId": "S1",
                "computerId": "PC1",
                "label": "S",
                "hardwareId": "H1",
                "url": "http://127.0.0.1/mcp",
                "lifecycle": {
                    "statusCommand": "s",
                    "startCommand": "a",
                    "stopCommand": "x",
                    "logPath": "l",
                },
            }
        )["transport"]
        == "mcp-http"
    )


@pytest.mark.ts_case(PREFIX + "validates managed hardware at the remote trust boundary")
def test_managed_state() -> None:
    with pytest.raises(ValidationError):
        parse_managed_hardware(
            {
                "hardwareId": "H1",
                "computerId": "PC1",
                "serverId": "S1",
                "state": "vendor-ready",
                "health": "ok",
            }
        )


@pytest.mark.ts_case(PREFIX + "requires the current project format")
def test_incomplete_project() -> None:
    with pytest.raises(ValidationError):
        parse_project_file({"formatVersion": 2})


@pytest.mark.ts_case(PREFIX + "uses strict named id inputs for IPC procedures")
def test_named_ids() -> None:
    for name in (
        "computer",
        "server",
        "hardware",
        "asset",
        "deviceBundle",
        "projectRootPath",
        "wiringTask",
        "run",
        "nodeRun",
        "task",
    ):
        assert parse_id_input({"id": "ID"}) == {"id": "ID"}, name
        with pytest.raises(ValidationError):
            parse_id_input({"id": "ID", "extra": True})
    from hardwareharness_backend.contracts.agents import parse_agent_kind_input

    assert parse_agent_kind_input({"id": "codex"}) == {"id": "codex"}


@pytest.mark.ts_case(PREFIX + "normalizes application errors for wire transport")
def test_errors() -> None:
    assert to_wire_error(app_error("conflict", "busy", {"holder": "run"})) == {
        "category": "conflict",
        "message": "busy",
        "details": {"holder": "run"},
    }
    assert to_wire_error(RuntimeError("boom")) == {"category": "error", "message": "boom"}
