"""A device as a plugin: the in-process host and the isolated child process."""

from __future__ import annotations

import asyncio
import sys

import pytest

from hardwareharness_device_sdk import (
    DeviceHost,
    InprocDevice,
    SubprocessDevice,
    device_types,
    load_device,
    open_device,
)
from hardwareharness_device_sdk.testing import dry_run_config

from sdk_demo import DemoDevice


def test_installed_types_come_from_entry_points():
    types = device_types()
    assert {"pci6208v", "pci1710l", "pci1762", "cp118u_i"} <= set(types)
    assert load_device("pci6208v").isolation == "subprocess"
    assert load_device("cp118u_i").isolation == "inproc"
    assert load_device("sdk_demo:DemoDevice") is DemoDevice


async def test_host_calls_tools_without_a_transport():
    host = DeviceHost(DemoDevice, dry_run_config(DemoDevice), retry_delays=(0.05,))
    await host.start()
    try:
        tools = {tool["name"]: tool for tool in host.describe_tools()}
        assert tools["demo_set_level"]["_meta"]["hardwareharness"]["operationSemantics"]["kind"] == "actuate"
        assert "hardwareId" in tools["demo_set_level"]["inputSchema"]["properties"]
        result = await host.call("demo_set_level", {"hardwareId": "DEMO1_1", "channel": 1, "level": True},
                                 operation_id="op-7")
        assert result["ok"] and result["meta"]["operationId"] == "op-7"
        assert host.device.levels[1] is True
        invalid = await host.call("demo_set_level", {"hardwareId": "DEMO1_1", "channel": 9, "level": True})
        assert invalid["ok"] is False and invalid["error"]["category"] == "invalid_argument"
        unknown = await host.call("nope", {})
        assert unknown["ok"] is False and unknown["error"]["category"] == "not_supported"
    finally:
        await host.stop()
    assert host.device.safe_calls >= 2  # after open and before close


async def test_host_streams_read_seek_and_watch():
    host = DeviceHost(DemoDevice, dry_run_config(DemoDevice), retry_delays=(0.05,))
    await host.start()
    try:
        await host.call("demo_set_level", {"hardwareId": "DEMO1_1", "channel": 0, "level": True})
        first = host.read_stream("do", 0, 100)
        assert first["records"] and first["streamType"] == "bits" and first["next"] >= 1
        assert host.read_stream("do", first["next"], 100)["records"] == []
        assert host.seek("do", first["records"][-1]["t"] + 1) == first["records"][-1]["seq"]
        host.watch("di")
        await asyncio.sleep(0.15)
        assert host.read_stream("di", 0, 100)["records"]
        host.unwatch("di")
    finally:
        await host.stop()


async def test_open_device_follows_isolation():
    assert isinstance(open_device("sdk_demo:DemoDevice", dry_run_config(DemoDevice)), InprocDevice)
    device = open_device("pci6208v", dry_run_config(load_device("pci6208v")))
    assert isinstance(device, SubprocessDevice)


@pytest.mark.skipif(sys.platform != "win32", reason="the adapters target Windows")
async def test_child_process_serves_the_device_and_survives_stdout_noise():
    device_cls = load_device("pci6208v")
    device = SubprocessDevice("pci6208v", dry_run_config(device_cls), [sys.executable, "-c",
        "import os,sys; os.write(1, b'driver banner' + bytes([10])); "
        "from hardwareharness_device_sdk.plugin import child_main; sys.exit(child_main())"])
    await device.start()
    try:
        described = await device.describe()
        names = {tool["name"] for tool in described["tools"]}
        assert "pci6208v_set_voltage" in names and described["device"]["identity"]["dryRun"] is True
        result = await device.call("pci6208v_set_voltage", {"hardwareId": device.config.hardware_id,
                                                             "channel": 0, "volts": 1.5}, "op-1")
        assert result["ok"] and result["meta"]["operationId"] == "op-1"
        read = await device.read_stream("ao0", 0, 50)
        assert read["records"][-1]["v"] == 1.5
        safe = await device.safe_all()
        assert safe[0]["hardwareId"] == device.config.hardware_id
    finally:
        await device.stop()
    assert device.process is None


@pytest.mark.skipif(sys.platform != "win32", reason="the adapters target Windows")
async def test_child_process_exits_safely_when_stdin_closes():
    device_cls = load_device("pci6208v")
    device = SubprocessDevice("pci6208v", dry_run_config(device_cls))
    await device.start()
    process = device.process
    assert process is not None and process.stdin is not None
    process.stdin.close()
    assert await asyncio.wait_for(process.wait(), 10) == 0
    with pytest.raises(Exception, match="not running|exited"):
        await device.call("pci6208v_safe_state", {"hardwareId": device.config.hardware_id})
