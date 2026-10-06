"""Device plugins loaded into the backend: the real adapters, with their simulated drivers
swapped in by the test (the product always drives real hardware)."""

from __future__ import annotations

import asyncio
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from teststand_device_sdk import DeviceConfig, DeviceHandle, open_device

from teststand_backend.contracts.errors import AppError
from teststand_backend.devices import (
    DeviceService,
    DeviceStore,
    PluginTransport,
)
from teststand_backend.devices.plugin_transport import child_command, installed_device_types
from teststand_backend.streams.clock import SHARED_CLOCK
from teststand_backend.streams.source import StreamSources

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="the adapters target Windows")


def plugin(device_id: str, device_type: str, hardware_id: str) -> dict[str, Any]:
    return {
        "deviceId": device_id,
        "label": device_id,
        "hardwareId": hardware_id,
        "type": device_type,
        "settings": {},
    }


def simulated(device_type: str, config: DeviceConfig) -> DeviceHandle:
    """The adapter on its simulated driver, so these tests need no hardware."""
    return open_device(device_type, replace(config, dry_run=True), child_command=child_command())


async def devices(
    tmp_path: Path, *devices: dict[str, Any]
) -> tuple[DeviceService, PluginTransport]:
    store = DeviceStore(tmp_path)
    await store.initialize()
    transport = PluginTransport(simulated)
    service = DeviceService(store, transport)
    for instance in devices:
        await service.save_device(instance)
        await service.refresh_device(instance["deviceId"])
    return service, transport


def test_installed_types_are_the_four_cards() -> None:
    types = {item["type"]: item for item in installed_device_types()}
    assert {"pci1710l", "pci1762", "pci6208v", "cp118u_i"} <= set(types)
    assert types["pci6208v"]["isolation"] == "subprocess"
    assert types["pci1762"]["model"] == "PCI-1762"


async def test_an_inproc_plugin_serves_tools_declaration_and_streams(tmp_path: Path) -> None:
    service, transport = await devices(tmp_path, plugin("RELAY", "pci1762", "RELAY_CARD"))
    try:
        names = {tool["externalName"] for tool in service.list_tools()}
        assert {"RELAY__pci1762_set_relay", "RELAY__pci1762_safe_state"} <= names
        assert service.get_definition("RELAY_CARD")["offline"] is False  # type: ignore[index]
        assert [item["hardwareId"] for item in await service.refresh_hardware()] == ["RELAY_CARD"]
        assert {item["id"] for item in await service.list_streams("RELAY_CARD")} >= {"relay", "di"}

        sources = StreamSources(transport.device_for)
        assert sources.clock("RELAY_CARD") is SHARED_CLOCK
        source = sources.source("RELAY_CARD", "relay", since=0.0)
        events = source.events()
        assert (await anext(events))["type"] == "hello"

        result = await service.call_aggregated_tool(
            "RELAY__pci1762_set_relay",
            {"channel": 3, "closed": True},
            {"envelope": True, "operationId": "op-1"},
        )
        assert result["meta"]["operationId"] == "op-1"
        while True:
            event = await asyncio.wait_for(anext(events), 5)
            if event["type"] == "batch" and any(r["mask"] & 0b1000 for r in event["records"]):
                break
        assert all(record["tb"] == record["t"] for record in event["records"])
        await events.aclose()  # type: ignore[attr-defined]

        with pytest.raises(AppError) as failure:
            await service.call_aggregated_tool("RELAY__pci1762_set_relay", {"channel": 99})
        assert failure.value.category == "invalid_argument"
        await service.safe_all()
        state = await service.call_aggregated_tool(
            "RELAY__pci1762_read_bit", {"channel": 3, "kind": "DO"}
        )
        assert state["value"] is False
    finally:
        await transport.close()


async def test_an_isolated_plugin_runs_in_a_child_process(tmp_path: Path) -> None:
    service, transport = await devices(tmp_path, plugin("AO", "pci6208v", "AO_CARD"))
    try:
        device = transport.device_for("AO_CARD")
        assert device is not None and device.isolation == "subprocess"
        await service.call_aggregated_tool("AO__pci6208v_set_voltage", {"channel": 2, "volts": 2.5})
        read = await device.read_stream("ao2", 0, 50)
        assert read["records"][-1]["v"] == 2.5
        await service.safe_all()
        assert (await device.read_stream("ao2", 0, 50))["records"][-1]["v"] == 0.0
    finally:
        await transport.close()
    assert device.process is None  # type: ignore[attr-defined]


async def test_a_dead_device_process_is_an_unknown_outcome(tmp_path: Path) -> None:
    service, transport = await devices(tmp_path, plugin("AO", "pci6208v", "AO_CARD"))
    try:
        device: Any = transport.device_for("AO_CARD")
        device.process.kill()
        await device.process.wait()
        with pytest.raises(AppError) as failure:
            await service.call_aggregated_tool(
                "AO__pci6208v_set_voltage", {"channel": 0, "volts": 1}
            )
        assert failure.value.category == "unavailable"
        assert failure.value.details["outcomeKnown"] is False
    finally:
        await transport.close()


async def test_an_instance_of_an_uninstalled_type_says_so(tmp_path: Path) -> None:
    service, transport = await devices(tmp_path, plugin("GONE", "removed_card", "GONE_CARD"))
    [status] = service.list_device_statuses()
    assert status["transport"]["state"] != "online"
    assert "removed_card is not installed" in status["transport"]["message"]


async def test_connecting_gives_the_hardware_the_plugin_s_connector_pins(tmp_path: Path) -> None:
    service, transport = await devices(tmp_path, plugin("RELAY", "pci1762", "RELAY_CARD"))
    try:
        hardware = service.store.require_hardware("RELAY_CARD")
        [port] = hardware["ports"]
        assert (hardware["label"], port["name"], len(port["pins"])) == ("RELAY", "CN1", 62)
        assert port["pins"][0] == {"pinId": "RELAY_CARD.CN1.1", "position": 1, "label": "IDI1"}
    finally:
        await transport.disconnect("RELAY")
