from __future__ import annotations

import base64
import time

import pytest

from hardwareharness_device_sdk import CONTRACT_REVISION, __version__
from hardwareharness_device_sdk.app import DeviceService
from hardwareharness_device_sdk.testing import check_device, dry_run_config, serve

from sdk_demo import PNG, DemoDevice

DEVICE_TOOLS = {"demo_set_level", "demo_read_level", "demo_configure", "demo_write_text", "demo_capture",
                "demo_explode", "demo_safe_state"}
BUILTINS = {"get_server_info", "list_hardware", "get_hardware_info", "hardwareharness_prepare_shutdown",
            "demo_stream_read", "demo_blob_read", "demo_transact"}


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
    assert meta(hh.tools["demo_transact"])["operationSemantics"]["kind"] == "actuate"
    assert meta(hh.tools["demo_stream_read"])["operationSemantics"]["kind"] == "read"


def test_calls_return_envelopes(hh):
    result = hh.call("set_level", channel=2, level=True)
    assert result["ok"] is True and result["data"] == {"channel": 2, "level": True}
    assert hh.call("read_level", channel=2)["data"]["level"] is True
    failed = hh.call("explode")
    assert failed["ok"] is False
    assert failed["error"]["category"] == "device_error" and failed["error"]["details"] == {"partial": [1]}
    assert failed["error"]["retryable"] is False
    assert failed["meta"]["operationId"].startswith("srv-")


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
    assert caps["streamTransport"] == {"protocol": "sse", "path": "/streams/{streamId}", "timePath": "/time",
                                       "auth": "bearer", "declaration": "/device streams",
                                       "readTool": "demo_stream_read"}
    assert caps["declarationPath"] == "/device"
    info = hh.call("get_hardware_info")["data"]
    assert info["capabilities"] == ["DO", "DI", "AI", "SERIAL"]
    assert info["capabilityDetails"]["contractRevision"] == CONTRACT_REVISION


def test_declaration_tools_are_gone(hh):
    assert not {"get_pinout", "list_streams"} & set(hh.tools)


def test_stream_read_and_operation_refs(hh):
    head = hh.service.device.out.buffer.head
    first = hh.call("set_level", {"operationId": "op-a"}, channel=0, level=True)
    hh.call("set_level", channel=1, level=True)
    assert first["meta"]["operationId"] == "op-a"
    assert first["meta"]["streamRefs"] == [{"streamId": "do", "fromSeq": head, "toSeq": head}]
    timing = first["meta"]["timing"]
    assert timing["end"] >= timing["start"]
    data = hh.call("stream_read", streamId="do", fromSeq=head)["data"]
    assert [record["mask"] for record in data["records"]] == [1, 3]
    assert data["records"][0]["op"] == "op-a" and data["records"][1]["op"].startswith("srv-")
    assert data["next"] == head + 2 and data["epoch"] == hh.service.device.out.buffer.epoch
    assert data["type"] == "bits" and data["status"]["state"] == "live"
    assert hh.call("stream_read", streamId="do", fromSeq=data["next"])["data"]["records"] == []
    latest = hh.call("stream_read", streamId="do", limit=1)["data"]["records"]
    assert [record["mask"] for record in latest] == [3]
    unknown = hh.call("stream_read", streamId="missing")
    assert unknown["ok"] is False and unknown["error"]["details"]["known"] == sorted(hh.service.device.streams)


def test_transact_sends_and_waits_for_reply(hh):
    result = hh.call("transact", {"operationId": "op-t"}, streamId="serial1", data="AT\r\n", expect="OK")
    assert result["ok"] and result["data"]["matched"] is True and "OK" in result["data"]["text"]
    assert result["data"]["sent"] == 4 and hh.service.device.sent == [b"AT\r\n"]
    refs = result["meta"]["streamRefs"]
    assert refs[0]["streamId"] == "serial1" and refs[0]["toSeq"] > refs[0]["fromSeq"]
    records = hh.call("stream_read", streamId="serial1", fromSeq=refs[0]["fromSeq"])["data"]["records"]
    assert records[0] | {"seq": 0, "t": 0} == {"seq": 0, "t": 0, "dir": "tx", "data": "41540d0a", "op": "op-t",
                                               "text": "AT\r\n"}
    assert records[1]["dir"] == "rx" and records[1]["text"] == "OK\r\n"
    hexed = hh.call("transact", streamId="serial1", data="zz", encoding="hex")
    assert hexed["ok"] is False and hexed["error"]["category"] == "invalid_argument"


def test_blob_capture_and_read(hh):
    ref = hh.call("capture")["data"]["ref"]
    records = hh.call("stream_read", streamId="cam")["data"]["records"]
    assert records[-1]["ref"] == ref
    blob = hh.call("blob_read", streamId="cam", ref=ref)["data"]
    assert blob["mime"] == "image/png" and base64.b64decode(blob["base64"]) == PNG and blob["size"] == len(PNG)
    wrong = hh.call("blob_read", streamId="do", ref=ref)
    assert wrong["ok"] is False and wrong["error"]["category"] == "invalid_argument"


def test_auth_and_health(hh):
    health = hh.client.get("/health").json()
    assert health == {"healthy": True, "serverId": "DEMO1_MCP", "hardwareId": "DEMO1_1", "state": "open",
                      "sdkVersion": __version__, "manifestRevision": health["manifestRevision"]}
    assert health["manifestRevision"] == hh.service.manifest().revision
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
    assert device.di.status()["state"] == "closed"


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


def test_compliance_flags_unvalidated_ranges_and_streams(config):
    from hardwareharness_device_sdk import ScalarStream, tool

    class Sloppy(DemoDevice):
        def __init__(self, config):
            super().__init__(config)
            self.streams.add(ScalarStream("stuck", sample=lambda: None))
            self.streams["stuck"].sampler._advance = lambda t: None  # noqa: SLF001 - watermark never moves

        @tool(kind="configure", description="Set a demo voltage without checking the range the schema cannot express at all.")
        def set_voltage(self, value: float) -> dict:
            return {"value": value}

    failures = check_device(Sloppy)
    assert any("set_voltage.value: parameter description missing" in failure for failure in failures)
    assert any("stream stuck: watermark did not advance" in failure for failure in failures)


def test_cli_check_runs_compliance_in_dry_run(capsys):
    import json

    from hardwareharness_device_sdk.__main__ import main

    assert main(["--adapter", "sdk_demo:DemoDevice", "--check", "--log-level", "warning"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report | {"warnings": []} == {"adapter": "sdk_demo.DemoDevice", "ok": True, "failures": [], "warnings": []}
