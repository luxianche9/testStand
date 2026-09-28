from __future__ import annotations

import pytest

from hardwareharness_device_sdk.sim import SERIAL_LOOPBACK_ENV
from hardwareharness_device_sdk.testing import check_device, dry_run_config, receive_until, serve
from hh_adapter_cp118u_i import DEVICE, Cp118uI
from hh_adapter_cp118u_i.adapter import configured_ports
from hh_adapter_cp118u_i.pinout import pinout

PUBLIC_TOOLS = {
    "get_server_info", "list_hardware", "get_hardware_info", "get_pinout", "list_streams", "get_panel",
    "cp118u_configure_port", "cp118u_write_text", "cp118u_write_hex", "cp118u_read_rx", "cp118u_clear_rx",
    "cp118u_flush", "cp118u_get_line_status", "cp118u_safe_state",
    "cp118u_stream_read", "cp118u_stream_start", "cp118u_stream_stop",
}


@pytest.fixture
def hh():
    with serve(Cp118uI) as harness:
        yield harness


@pytest.fixture
def loopback(monkeypatch):
    monkeypatch.setenv(SERIAL_LOOPBACK_ENV, "1")
    with serve(Cp118uI) as harness:
        yield harness


def rx_text(harness, channel, **arguments):
    return harness.call("read_rx", channel=channel, **arguments)


def test_entry_point_and_compliance():
    assert DEVICE is Cp118uI
    assert check_device(Cp118uI) == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["hardwareharness"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    semantics = {name: hh.tools[name]["_meta"]["hardwareharness"]["operationSemantics"] for name in PUBLIC_TOOLS
                 if name.startswith("cp118u_") and "stream" not in name}
    assert semantics["cp118u_configure_port"]["stateEffects"] == ["serial_port_configured"]
    for name in ("cp118u_write_text", "cp118u_write_hex", "cp118u_read_rx", "cp118u_clear_rx", "cp118u_flush"):
        assert semantics[name]["stateRequirements"] == ["serial_port_configured"]
    assert semantics["cp118u_read_rx"]["evidenceType"] == "measurement"
    assert semantics["cp118u_write_text"]["retry"] == "never_after_dispatch"
    assert semantics["cp118u_safe_state"]["kind"] == "safe"
    channel = hh.tools["cp118u_write_text"]["inputSchema"]["properties"]["channel"]
    assert (channel["minimum"], channel["maximum"]) == (1, 8)


def test_configure_and_line_status(hh):
    data = hh.call("configure_port", channel=2, baud=115200, data_bits=7, parity="e", stop_bits=2)["data"]
    assert data["port"] == 4 and data["baud"] == 115200
    status = hh.call("get_line_status", channel=2)["data"]
    assert (status["baud"], status["frame"], status["port"]) == (115200, "7E2", 4)
    assert hh.call("get_hardware_info")["data"]["capabilityDetails"]["configuredChannels"] == [2]


def test_invalid_arguments_rejected(hh):
    hh.call("configure_port", channel=1)
    assert hh.call("write_hex", channel=1, hex_data="0g")["error"]["category"] == "invalid_argument"
    result = hh.mcp.call_raw("cp118u_write_text", {"hardwareId": hh.hardware_id, "channel": 9, "text": "x"})
    assert result.get("isError") or not result["structuredContent"]["ok"]
    assert hh.service.device.pcomm.writes == []


def test_no_invented_rx_without_loopback(hh):
    hh.call("configure_port", channel=1)
    assert hh.call("write_text", channel=1, text="ping")["data"] == {"channel": 1, "bytes": 4}
    assert rx_text(hh, 1)["data"]["bytes"] == 0
    failure = rx_text(hh, 1, timeout_ms=20)
    assert failure["error"]["category"] == "device_error"
    assert failure["error"]["details"] == {"channel": 1, "hex": "", "text": "", "bytes": 0}


def test_loopback_read_rx_is_nonconsuming_and_clearable(loopback):
    loopback.call("configure_port", channel=3)
    loopback.call("write_hex", channel=3, hex_data="01 03 00 00")
    loopback.call("write_text", channel=3, text="OK")
    first = rx_text(loopback, 3)["data"]
    assert first["hex"] == "01 03 00 00 4f 4b" and first["overflow"] is False
    assert rx_text(loopback, 3)["data"] == first
    assert rx_text(loopback, 3, max_bytes=2)["data"]["hex"] == "01 03"
    loopback.call("clear_rx", channel=3)
    assert rx_text(loopback, 3)["data"]["bytes"] == 0
    loopback.call("write_text", channel=3, text="A", clear_rx=True)
    assert rx_text(loopback, 3)["data"]["text"] == "A"
    loopback.call("flush", channel=3, what="RX")
    assert rx_text(loopback, 3)["data"]["bytes"] == 0


def test_stream_carries_tx_and_rx(loopback):
    loopback.call("configure_port", channel=1)
    with loopback.websocket("serial1", cursor=0) as socket:
        hello = receive_until(socket, lambda frame: frame["type"] == "hello")
        assert hello["kind"] == "bytes"
        loopback.call("write_text", channel=1, text="hi")
        seen: list[tuple[str, str]] = []

        def both(frame):
            seen.extend((item["dir"], item["text"]) for item in frame.get("items", []))
            return {"tx", "rx"} <= {direction for direction, _ in seen}

        receive_until(socket, lambda frame: frame["type"] == "batch" and both(frame))
    assert ("tx", "hi") in seen


def test_injected_peer_bytes_reach_read_rx(hh):
    hh.call("configure_port", channel=5)
    hh.service.device.pcomm.inject(7, b"\xff\x00peer")
    data = rx_text(hh, 5)["data"]
    assert data["hex"].startswith("ff 00") and data["text"].endswith("peer")


def test_safe_state_idempotent_and_keeps_rx(loopback):
    loopback.call("configure_port", channel=1)
    loopback.call("write_text", channel=1, text="x")
    assert loopback.call("safe_state")["data"] == {"tx_flushed": list(range(1, 9))}
    assert loopback.call("safe_state")["ok"]
    assert rx_text(loopback, 1)["data"]["text"] == "x"


def test_port_map_configuration():
    assert configured_ports({}) == list(range(3, 11))
    assert configured_ports({"portMap": "11,12", "portCount": 2}) == [11, 12]
    with pytest.raises(ValueError):
        configured_ports({"portMap": "3,3", "portCount": 2})
    config = dry_run_config(Cp118uI, settings={"portCount": 2, "basePort": 20})
    with serve(Cp118uI, config) as harness:
        details = harness.call("get_hardware_info")["data"]["capabilityDetails"]
        assert details["portMap"] == {"1": 20, "2": 21}
        assert harness.call("configure_port", channel=3)["error"]["category"] == "invalid_argument"
        assert [item["id"] for item in harness.call("get_panel")["data"]["items"]] == ["serial1", "serial2",
                                                                                      "safe_state"]


def test_panel_references(hh):
    items = {item["id"]: item for item in hh.call("get_panel")["data"]["items"]}
    terminal = items["serial1"]
    assert terminal["widget"] == "terminal" and terminal["stream"] == "serial1"
    assert terminal["write"]["tool"] == "cp118u_write_text"
    assert terminal["actions"]["sendHex"]["tool"] == "cp118u_write_hex"
    assert len(terminal["pins"]) == 9


def test_pinout():
    data = pinout("PC1_MCP.CP118U_I_CARD_0")
    assert len(data.connectors) == 8 and len(data.pins) == 72
    assert data.modeSelection == "hardware_dip" and {mode.mode for mode in data.modes} == {
        "rs232", "rs422_rs485_4wire", "rs485_2wire"}
