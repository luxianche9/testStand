from __future__ import annotations


import pytest

from hardwareharness_device_sdk.testing import check_device, receive_until, serve
from hh_adapter_pci1762 import DEVICE, Pci1762
from hh_adapter_pci1762.pinout import pinout


PUBLIC_TOOLS = {
    "get_server_info", "list_hardware", "get_hardware_info",
    "pci1762_set_relay", "pci1762_set_bank", "pci1762_read_bit", "pci1762_safe_state",
    "pci1762_stream_read",
}


@pytest.fixture
def hh():
    with serve(Pci1762) as harness:
        yield harness


def test_entry_point_and_compliance():
    assert DEVICE is Pci1762
    warnings: list[str] = []
    assert check_device(Pci1762, warnings=warnings) == []
    assert warnings == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["hardwareharness"]["kind"] == "internal"}
    assert internal == {"hardwareharness_prepare_shutdown"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    for name in ("pci1762_set_relay", "pci1762_set_bank"):
        semantics = hh.tools[name]["_meta"]["hardwareharness"]["operationSemantics"]
        assert semantics["retry"] == "never_after_dispatch"
        assert semantics["safetyAction"] == {"toolName": "pci1762_safe_state", "arguments": {}}
    kind = hh.tools["pci1762_read_bit"]["inputSchema"]["properties"]["kind"]
    assert kind["pattern"] == "^(?i:DI|DO|RELAY)$"
    mask = hh.tools["pci1762_set_bank"]["inputSchema"]["properties"]["mask"]
    assert (mask["minimum"], mask["maximum"]) == (0, 65535)


@pytest.mark.parametrize("arguments", [{"channel": 16, "closed": True}, {"channel": -1, "closed": False}])
def test_invalid_relay_rejected(hh, arguments):
    before = len(hh.service.device.cli.commands)
    result = hh.mcp.call_raw("pci1762_set_relay", {"hardwareId": hh.hardware_id, **arguments})
    assert result.get("isError") or not result["structuredContent"]["ok"]
    assert len(hh.service.device.cli.commands) == before


def test_relay_writes_publish_readback(hh):
    result = hh.call("set_relay", {"operationId": "op-r"}, channel=9, closed=True)
    assert result["data"] == {"channel": 9, "closed": True, "port": 1, "bit": 1}
    assert [ref["streamId"] for ref in result["meta"]["streamRefs"]] == ["relay"]
    assert hh.call("read_bit", channel=9, kind="relay")["data"]["value"] is True
    assert hh.call("read_bit", channel=9, kind="DO")["data"]["value"] is True
    assert hh.call("read_bit", channel=9)["data"]["value"] is False
    last = hh.call("stream_read", streamId="relay", limit=1)["data"]["records"][-1]
    assert last["mask"] == 1 << 9 and last["op"] == "op-r"
    assert hh.call("set_bank", mask=0x8001)["data"] == {"mask": 0x8001}
    with hh.sse("relay", cursor=-1) as events:
        batch = receive_until(events, lambda frame: frame["type"] == "batch" and frame["records"])
        assert batch["records"][-1]["mask"] == 0x8001
    assert hh.call("safe_state")["data"] == {"relays": "all_open"}
    assert hh.call("stream_read", streamId="relay", limit=1)["data"]["records"][-1]["mask"] == 0
    assert hh.call("read_bit", channel=0, kind="RELAY")["data"]["value"] is False


def test_di_is_sampled_in_one_round_trip_and_only_on_change(hh):
    device = hh.service.device
    assert hh.get("/device").json()["streams"] == [
        {"id": "di", "type": "bits", "width": 16, "bitLabels": [f"IDI{n}" for n in range(16)], "rateHz": 20.0,
         "kind": "measured"},
        {"id": "relay", "type": "bits", "width": 16, "bitLabels": [f"R{n}" for n in range(16)],
         "label": "Relay coil control"}]
    assert device.mask_command is True
    with hh.sse("di") as events:
        events.receive()
        device.cli.di = 0b101
        receive_until(events, lambda frame: frame["type"] == "batch"
                      and any(record["mask"] == 0b101 for record in frame["records"]))
        head = device.di.buffer.head
        receive_until(events, lambda frame: frame["type"] == "status")
        assert device.di.buffer.head == head
    assert not any(command["cmd"] == "read_bit" for command in device.cli.commands)


def test_falls_back_to_bit_reads_without_read_mask():
    from hh_adapter_pci1762.sim import SimulatedHwcli

    class OldCli(SimulatedHwcli):
        def call(self, command):
            if command.get("cmd") == "read_mask":
                return {"ok": False, "reachable": False, "message": "unknown read_mask", "data": None}
            return super().call(command)

    class OldPci1762(Pci1762):
        def __init__(self, config):
            super().__init__(config)
            self.cli = OldCli()

    with serve(OldPci1762) as harness:
        device = harness.service.device
        assert device.mask_command is False
        harness.call("set_relay", channel=2, closed=True)
        assert harness.call("stream_read", streamId="relay", limit=1)["data"]["records"][-1]["mask"] == 4


def test_capability_details(hh):
    details = hh.call("get_hardware_info")["data"]["capabilityDetails"]
    assert details["bankAtomic"] is False and details["contactContinuityMeasurement"] is False


def test_pinout():
    data = pinout("PC1_MCP.PCI1762_CARD_0")
    assert len(data.pins) == 62 and len({pin.pinId for pin in data.pins}) == 62
    relays = {pin.functions[0].channelIndex for pin in data.pins if pin.functions[0].channelKind == "relay"}
    assert relays == set(range(16))


def test_device_declaration(hh):
    document = hh.get("/device").json()
    assert document["description"].startswith("Advantech PCI-1762")
    assert len(document["pinout"]["connectors"][0]["pinIds"]) == 62
    assert hh.service.device.board_description == "PCI-1762,BID#0"

