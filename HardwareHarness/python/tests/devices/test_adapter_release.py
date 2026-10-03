from __future__ import annotations

from pathlib import Path

import pytest

from hardwareharness_backend.application import OPERATIONS
from hardwareharness_backend.application.authorization import DefaultAuthorizer
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.devices import DeviceCatalogService, DeviceStore

from .test_device_store import hardware, instance

AGENT = {"actor": "agent", "source": "mcp"}
HUMAN = {"actor": "human", "source": "desktop"}


async def catalog(tmp_path: Path) -> DeviceCatalogService:
    store = DeviceStore(tmp_path / "devices")
    await store.save_hardware(hardware("CARD"))
    await store.save_hardware(hardware("BOX"))
    await store.save_device(instance("S1", "CARD"))
    return DeviceCatalogService(store)


async def test_adapter_is_available_only_after_check_simulator_and_bench_smoke(
    tmp_path: Path,
) -> None:
    devices = await catalog(tmp_path)
    assert devices.get_hardware("CARD")["adapterStatus"] == "developing"
    assert "adapterStatus" not in devices.get_hardware("BOX")
    assert devices.adapter_status("CARD")["gaps"] == ["check", "simulator", "smoke"]

    await devices.record_adapter_check("CARD", "check", "uv run hh-adapter --check")
    await devices.record_adapter_check("CARD", "simulator")
    with pytest.raises(AppError) as blocked:
        await devices.set_adapter_status("CARD", "available")
    assert blocked.value.category == "conflict"
    assert blocked.value.details["gaps"] == ["smoke"]

    smoke = {"operator": "张工", "wiring": "AO0 → AI0", "observation": "AI0 读到 2.50 V"}
    status = await devices.record_adapter_smoke("CARD", smoke)
    assert status["gaps"] == []
    assert status["smoke"][0]["operator"] == "张工" and status["smoke"][0]["at"]
    released = await devices.set_adapter_status("CARD", "available")
    assert released["status"] == "available"
    assert devices.get_hardware("CARD")["adapterStatus"] == "available"
    # The record survives a fresh store on the same directory.
    reopened = DeviceCatalogService(DeviceStore(tmp_path / "devices"))
    assert reopened.adapter_status("CARD")["status"] == "available"

    with pytest.raises(AppError, match="passive"):
        devices.adapter_status("BOX")


def test_only_a_human_records_bench_smoke_or_releases_an_adapter() -> None:
    authorizer = DefaultAuthorizer()
    for name in ("devices.recordAdapterSmoke", "devices.setAdapterStatus"):
        spec = OPERATIONS[name].spec
        assert spec.capability == "hardware.releaseAdapters"
        assert not spec.profiles
        assert not authorizer.is_allowed(AGENT, spec.capability)
        assert authorizer.is_allowed(HUMAN, spec.capability)
    assert authorizer.is_allowed(AGENT, OPERATIONS["devices.recordAdapterCheck"].spec.capability)
