from __future__ import annotations

import time

import pytest

from hardwareharness_device_sdk.sim import SERIAL_LOOPBACK_ENV
from hardwareharness_device_sdk.testing import check_device, dry_run_config, receive_until, serve
from hh_adapter_cp118u_i import DEVICE, Cp118uI
from hh_adapter_cp118u_i.adapter import configured_ports
from hh_adapter_cp118u_i.pinout import pinout


PUBLIC_TOOLS = {
    "get_server_info", "list_hardware", "get_hardware_info",
    "cp118u_configure_port", "cp118u_write_text", "cp118u_write_hex", "cp118u_read_rx", "cp118u_clear_rx",
    "cp118u_flush", "cp118u_get_line_status", "cp118u_safe_state",
    "cp118u_stream_read", "cp118u_transact",
}
BUILTIN = ("stream_read", "transact")


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
    warnings: list[str] = []
    assert check_device(Cp118uI, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["hardwareharness"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    semantics = {name: hh.tools[name]["_meta"]["hardwareharness"]["operationSemantics"] for name in PUBLIC_TOOLS
                 if name.startswith("cp118u_") and name.removeprefix("cp118u_") not in BUILTIN}
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
    result = hh.call_raw("cp118u_write_text", {"hardwareId": hh.hardware_id, "channel": 9, "text": "x"})
    assert result["ok"] is False
    assert hh.host.device.pcomm.writes == []


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


def test_streams_are_bytes(hh):
    assert hh.device()["streams"] == [{"id": f"serial{channel}", "type": "bytes", "writable": True}
                                                   for channel in range(1, 9)]
    assert hh.call("stream_read", streamId="serial1")["data"]["status"]["state"] == "not_configured"


def test_stream_carries_marks_tx_and_rx(loopback):
    loopback.call("configure_port", channel=1, baud=115200)
    with loopback.subscribe("serial1", cursor=0) as events:
        assert receive_until(events, lambda frame: frame["type"] == "hello")["streamType"] == "bytes"
        loopback.call("write_text", operation_id="op-w", channel=1, text="hi")
        seen: list[dict] = []

        def both(frame):
            seen.extend(frame.get("records", []))
            return {"tx", "rx"} <= {record["dir"] for record in seen}

        receive_until(events, lambda frame: frame["type"] == "batch" and both(frame))
    assert seen[0]["dir"] == "mark" and seen[0]["note"] == "configure_port baud=115200 8N1 flow=0"
    tx = next(record for record in seen if record["dir"] == "tx")
    assert tx["data"] == "6869" and tx["op"] == "op-w"


def test_write_returns_stream_refs(hh):
    hh.call("configure_port", channel=2)
    result = hh.call("write_hex", operation_id="op-x", channel=2, hex_data="01 02", clear_rx=True)
    refs = result["meta"]["streamRefs"]
    assert [ref["streamId"] for ref in refs] == ["serial2"]
    records = hh.call("stream_read", streamId="serial2", fromSeq=refs[0]["fromSeq"])["data"]["records"]
    assert [(record["dir"], record.get("note")) for record in records] == [("mark", "clear_rx"), ("tx", None)]
    assert records[1]["data"] == "0102" and {record["op"] for record in records} == {"op-x"}


def test_transact_round_trip_on_loopback(loopback):
    assert loopback.call("transact", streamId="serial4", data="x")["error"]["category"] == "not_configured"
    loopback.call("configure_port", channel=4)
    result = loopback.call("transact", streamId="serial4", data="AT;", expect="AT", timeoutMs=2000)
    assert result["ok"] and result["data"]["matched"] is True and result["data"]["sent"] == 3
    assert loopback.host.device.pcomm.writes[-1] == (6, b"AT;")


def test_injected_peer_bytes_reach_read_rx(hh):
    hh.call("configure_port", channel=5)
    hh.host.device.pcomm.inject(7, b"\xff\x00peer")
    data = rx_text(hh, 5)["data"]
    assert data["hex"].startswith("ff 00") and data["text"].endswith("peer")


def test_safe_state_idempotent_and_keeps_rx(loopback):
    loopback.call("configure_port", channel=1)
    loopback.call("write_text", channel=1, text="x")
    assert loopback.call("safe_state")["data"] == {"tx_flushed": list(range(1, 9))}
    assert loopback.call("safe_state")["ok"]
    assert rx_text(loopback, 1)["data"]["text"] == "x"


def test_port_map_configuration():
    assert configured_ports({}, discover=lambda count: None) == list(range(3, 11))
    moxa = [3, 4, 8, 7, 10, 5, 9, 6]
    assert configured_ports({}, discover=lambda count: moxa[:count]) == moxa
    assert configured_ports({"basePort": 20, "portCount": 2}, discover=lambda count: moxa) == [20, 21]
    assert configured_ports({"portMap": "11,12", "portCount": 2}, discover=lambda count: moxa) == [11, 12]
    assert configured_ports({"portMap": "11,12", "portCount": 2}) == [11, 12]
    with pytest.raises(ValueError):
        configured_ports({"portMap": "3,3", "portCount": 2})
    config = dry_run_config(Cp118uI, settings={"portCount": 2, "basePort": 20})
    with serve(Cp118uI, config) as harness:
        details = harness.call("get_hardware_info")["data"]["capabilityDetails"]
        assert details["portMap"] == {"1": 20, "2": 21}
        assert harness.call("configure_port", channel=3)["error"]["category"] == "invalid_argument"
        assert [stream["id"] for stream in harness.device()["streams"]] == ["serial1", "serial2"]


def test_pinout():
    data = pinout("PC1_MCP.CP118U_I_CARD_0")
    assert len(data.connectors) == 8 and len(data.pins) == 72
    assert data.modeSelection == "hardware_dip" and {mode.mode for mode in data.modes} == {
        "rs232", "rs422_rs485_4wire", "rs485_2wire"}


def test_reader_idles_every_stream(hh):
    hh.call("configure_port", channel=1)
    time.sleep(0.1)
    for channel in (1, 2):
        stream = hh.host.device.streams[f"serial{channel}"]
        assert stream.idle_driven and stream.buffer.watermark() > time.time() * 1000 - 200


def test_device_declaration(hh):
    document = hh.device()
    assert document["description"].startswith("Moxa CP-118U-I") and "DIP switch" in document["description"]
    connectors = document["pinout"]["connectors"]
    assert [len(connector["pinIds"]) for connector in connectors] == [9] * 8
    assert connectors[1]["pinIds"][0].endswith(".P2.1")

