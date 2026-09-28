from __future__ import annotations

import time

import pytest

from hardwareharness_device_sdk import CONTRACT_REVISION, __version__
from hardwareharness_device_sdk.app import DeviceService
from hardwareharness_device_sdk.testing import check_device, dry_run_config, serve

from sdk_demo import DemoDevice

DEVICE_TOOLS = {"demo_set_level", "demo_read_level", "demo_configure", "demo_write_text", "demo_explode", "demo_safe_state"}
BUILTINS = {"get_server_info", "list_hardware", "get_hardware_info", "get_pinout", "list_streams", "get_panel",
            "hardwareharness_prepare_shutdown", "demo_stream_read", "demo_stream_start", "demo_stream_stop"}


def meta(tool: dict) -> dict:
    return tool["_meta"]["hardwareharness"]


def test_compliance_suite_passes():
    assert check_device(DemoDevice) == []


def test_tool_inventory(hh):
    assert set(hh.tools) == DEVICE_TOOLS | BUILTINS


def test_device_tool_schema_and_semantics(hh):
    tool = hh.tools["demo_set_level"]
    schema = tool["inputSchema"]
    assert schema["required"] == ["hardwareId", "channel", "level"]
    assert schema["properties"]["channel"] == {"description": "Zero-based output channel 0..3.", "maximum": 3,
                                               "minimum": 0, "title": "Channel", "type": "integer"}
    assert tool["annotations"]["destructiveHint"] is True and tool["annotations"]["readOnlyHint"] is False
    assert set(tool["outputSchema"]["properties"]) >= {"ok", "data", "error", "meta"}
    info = meta(tool)
    assert info["kind"] == "hardware" and info["contractRevision"] == CONTRACT_REVISION
    assert info["operationSemantics"] == {
        "kind": "actuate", "retry": "never_after_dispatch", "stateRequirements": [], "stateEffects": ["do_driven"],
        "evidenceType": "observation", "outcomeOnInvalidResponse": "unknown", "trusted": True,
        "safetyAction": {"toolName": "demo_safe_state", "arguments": {}},
    }
    assert meta(hh.tools["demo_safe_state"])["safeAction"] is True
    assert hh.tools["demo_read_level"]["annotations"]["readOnlyHint"] is True
    assert meta(hh.tools["demo_read_level"])["operationSemantics"]["retry"] == "safe"
    assert hh.tools["demo_configure"]["inputSchema"]["properties"]["mode"]["enum"] == ["fast", "slow"]
    assert meta(hh.tools["hardwareharness_prepare_shutdown"]) == {"kind": "internal"}
    assert meta(hh.tools["get_server_info"])["kind"] == "management"


def test_calls_return_envelopes(hh):
    result = hh.call("set_level", channel=2, level=True)
    assert result["ok"] is True and result["data"] == {"channel": 2, "level": True}
    assert hh.call("read_level", channel=2)["data"]["level"] is True
    failed = hh.call("explode")
    assert failed["ok"] is False
    assert failed["error"]["category"] == "device_error" and failed["error"]["details"] == {"partial": [1]}
    assert failed["error"]["retryable"] is False


def test_argument_validation_is_rejected_before_the_device(hh):
    result = hh.mcp.call_raw("demo_set_level", {"hardwareId": hh.hardware_id, "channel": 9, "level": True})
    assert result["isError"] is True
    assert hh.service.device.levels == [False] * 4


def test_unknown_hardware_id(hh):
    result = hh.mcp.call("demo_read_level", {"hardwareId": "nope", "channel": 0})
    assert result["ok"] is False and result["error"]["category"] == "invalid_argument"


def test_server_info_and_capabilities(hh):
    data = hh.call("get_server_info")["data"]
    assert data["sdkVersion"] == __version__ and data["version"] == "1.2.3" and data["adapter"] == "DEMO-1"
    assert data["startupComplete"] is True and data["hardware"][0]["state"] == "open"
    caps = data["capabilities"]
    assert caps["executionMode"] == "nonphysical_driver_override" and caps["hardwareCount"] == 1
    assert caps["streamTransport"]["path"] == "/streams/{streamId}"
    info = hh.call("get_hardware_info")["data"]
    assert info["capabilities"] == ["DO", "SERIAL"] and info["capabilityDetails"]["contractRevision"] == CONTRACT_REVISION


def test_pinout_not_supported_by_default(hh):
    result = hh.call("get_pinout")
    assert result["ok"] is False and result["error"]["category"] == "not_supported"


def test_panel_expands_tool_names(hh):
    items = {item["id"]: item for item in hh.call("get_panel")["data"]["items"]}
    assert items["do0"]["write"] == {"tool": "demo_set_level", "args": {"channel": 0, "level": "$value"}}
    assert items["safe"]["write"]["tool"] == "demo_safe_state"
    assert items["ai0"]["stream"] == "ai0" and items["ai0"]["unit"] == "V"


def test_list_streams(hh):
    streams = {item["streamId"]: item for item in hh.call("list_streams")["data"]}
    assert set(streams) == {"di", "ai0", "do", "serial1"}
    assert streams["di"]["kind"] == "sampled" and streams["di"]["state"] == "idle"
    assert streams["serial1"]["kind"] == "bytes" and streams["serial1"]["valueSchema"]["required"]
    assert streams["ai0"]["requires"] == ["configured"] and streams["ai0"]["channel"] == 0


def test_stream_read_via_mcp(hh):
    hh.call("set_level", channel=0, level=True)
    hh.call("set_level", channel=1, level=True)
    latest = hh.call("stream_read", streamId="do")["data"]
    assert [item["value"] for item in latest["items"]] == [1, 3]
    assert latest["next"] == 2 and latest["epoch"] == hh.service.device.out.buffer.epoch
    assert hh.call("stream_read", streamId="do", cursor=latest["next"])["data"]["items"] == []
    unknown = hh.call("stream_read", streamId="missing")
    assert unknown["ok"] is False and unknown["error"]["details"]["known"] == ["ai0", "di", "do", "serial1"]


def test_stream_start_samples_without_viewer(hh):
    hh.service.device.inputs = 5
    held = hh.call("stream_start", streamId="di", seconds=5)["data"]
    assert held["kind"] == "sampled" and held["holdSeconds"] > 4
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not hh.call("stream_read", streamId="di")["data"]["items"]:
        time.sleep(0.02)
    items = hh.call("stream_read", streamId="di")["data"]["items"]
    assert items and items[-1]["value"] == 5
    assert hh.call("stream_stop", streamId="di")["data"]["holdSeconds"] == 0
    push = hh.call("stream_start", streamId="do")
    assert push["ok"] and push["message"]


def test_auth_and_health(hh):
    assert hh.client.get("/health").json() == {"healthy": True, "serverId": "DEMO1_MCP", "hardwareId": "DEMO1_1",
                                               "state": "open", "sdkVersion": __version__}
    response = hh.client.post("/mcp", headers={"Authorization": "Bearer wrong"}, json={})
    assert response.status_code == 401
    assert hh.client.post("/admin/shutdown").status_code == 401


def test_prepare_shutdown_safes_and_drains(config):
    exits: list[int] = []
    with serve(DemoDevice, config, request_exit=lambda: exits.append(1), exit_delay=0) as hh:
        hh.call("set_level", channel=1, level=True)
        before = hh.service.device.safe_calls
        response = hh.client.post("/admin/shutdown", headers={"Authorization": f"Bearer {hh.token}"})
        body = response.json()
        assert body["ok"] and body["data"] == [{"hardwareId": "DEMO1_1", "safeResult": {"safe": True}}]
        assert hh.service.device.safe_calls == before + 1
        drained = hh.call("read_level", channel=0)
        assert drained["ok"] is False and drained["error"]["category"] == "service_unavailable"
        deadline = time.monotonic() + 2
        while not exits and time.monotonic() < deadline:
            time.sleep(0.01)
        assert exits == [1]


def test_lifecycle_open_safe_close(config):
    with serve(DemoDevice, config) as hh:
        device = hh.service.device
        assert device.safe_calls == 1
    assert device.safe_calls == 2
    assert hh.service.manager.runtime.state == "closed"


def test_model_mismatch_is_rejected():
    with pytest.raises(RuntimeError, match="does not match"):
        DeviceService(DemoDevice, dry_run_config(DemoDevice, model="OTHER"))


def test_unknown_safety_action_is_rejected(config):
    from hardwareharness_device_sdk import tool

    class Broken(DemoDevice):
        @tool(kind="actuate", safety_action="nope", description="x" * 90)
        def poke(self) -> dict:
            return {}

    with pytest.raises(RuntimeError, match="unknown safety_action"):
        DeviceService(Broken, config)


def test_panel_with_unknown_tool_is_rejected(config):
    from hardwareharness_device_sdk import PanelItem, ToolBinding

    class Broken(DemoDevice):
        def panel(self):
            return [PanelItem(id="x", label="x", widget="button", write=ToolBinding(tool="missing"))]

    with pytest.raises(RuntimeError, match="unknown tools"):
        DeviceService(Broken, config)


def test_cli_check_runs_compliance_in_dry_run(capsys):
    import json

    from hardwareharness_device_sdk.__main__ import main

    assert main(["--adapter", "sdk_demo:DemoDevice", "--check", "--log-level", "warning"]) == 0
    assert json.loads(capsys.readouterr().out) == {"adapter": "sdk_demo.DemoDevice", "ok": True, "failures": []}
