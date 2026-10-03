import pytest

from teststand_backend.contracts.devices import (
    parse_device_instance,
    parse_hardware,
    parse_managed_hardware,
)
from teststand_backend.contracts.errors import app_error, to_wire_error
from teststand_backend.contracts.projects import parse_project_file
from teststand_backend.contracts.validation import ValidationError, parse_id_input

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
                "deviceId": "S1",
                "computerId": "PC1",
                "ports": [],
            }
        )


@pytest.mark.ts_case(PREFIX + "applies stable defaults")
def test_defaults() -> None:
    assert parse_device_instance(
        {"deviceId": "P1", "label": "P", "hardwareId": "H2", "type": "pci1762"}
    ) == {
        "deviceId": "P1",
        "label": "P",
        "hardwareId": "H2",
        "type": "pci1762",
        "settings": {},
        "mode": "real",
        "enabled": True,
    }


@pytest.mark.ts_case(PREFIX + "validates managed hardware at the device trust boundary")
def test_managed_state() -> None:
    with pytest.raises(ValidationError):
        parse_managed_hardware(
            {
                "hardwareId": "H1",
                "deviceId": "S1",
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
        "device",
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
    from teststand_backend.contracts.agents import parse_agent_kind_input

    assert parse_agent_kind_input({"id": "codex"}) == {"id": "codex"}


@pytest.mark.ts_case(PREFIX + "normalizes application errors for wire transport")
def test_errors() -> None:
    assert to_wire_error(app_error("conflict", "busy", {"holder": "run"})) == {
        "category": "conflict",
        "message": "busy",
        "details": {"holder": "run"},
    }
    assert to_wire_error(RuntimeError("boom")) == {"category": "error", "message": "boom"}
