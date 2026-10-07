from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from teststand_backend.application import HUMAN_REQUEST_CONTEXT as HUMAN
from teststand_backend.application import DefaultAuthorizer, SignalsApplication
from teststand_backend.contracts.errors import AppError
from teststand_backend.contracts.signals import parse_signal_view
from teststand_backend.signals.signal_view import resolve, validate, write_call

RELAY = {
    "id": "relay",
    "type": "bits",
    "width": 16,
    "control": [
        {
            "action": "setBit",
            "tool": "pci1762_set_relay",
            "args": {"channel": {"$": "bit"}, "closed": {"$": "value"}},
        },
        {"action": "setMask", "tool": "pci1762_set_bank", "args": {"mask": {"$": "value"}}},
    ],
}
DI = {"id": "di", "type": "bits", "width": 16}
AO0 = {
    "id": "ao0",
    "type": "scalar",
    "control": [
        {
            "action": "set",
            "tool": "pci6208v_set_voltage",
            "args": {"channel": 0, "volts": {"$": "value"}},
        }
    ],
}
AI0 = {"id": "ai0", "type": "scalar"}
HARDWARE: dict[str, dict[str, Any]] = {
    "RELAY": {"hardwareId": "RELAY", "kind": "managed", "deviceId": "S1", "label": "PCI-1762"},
    "AO": {"hardwareId": "AO", "kind": "managed", "deviceId": "S2", "label": "PCI-6208V"},
    "OFFLINE": {
        "hardwareId": "OFFLINE",
        "kind": "managed",
        "deviceId": "S3",
        "label": "never seen",
    },
    "DUT": {
        "hardwareId": "DUT",
        "kind": "passive",
        "label": "unit",
        "signals": [
            {"signalId": "enable", "label": "", "type": "bits", "direction": "input"},
            {"signalId": "vref", "label": "", "type": "scalar", "direction": "input"},
            {"signalId": "status", "label": "", "type": "bits", "direction": "output", "width": 2},
        ],
    },
}
STREAMS: dict[str, list[dict[str, Any]] | None] = {
    "RELAY": [DI, RELAY],
    "AO": [AO0, AI0],
    "DUT": None,
    "OFFLINE": None,
}


class Catalog:
    def find_hardware(self, hardware_id: str) -> dict[str, Any] | None:
        return HARDWARE.get(hardware_id)

    def known_streams(self, hardware_id: str) -> list[dict[str, Any]] | None:
        return STREAMS.get(hardware_id)


def node(node_id: str, hardware_id: str | None = None, widget: str | None = None) -> dict[str, Any]:
    if widget:
        return {"nodeId": node_id, "kind": "widget", "widget": widget, "x": 0, "y": 0}
    return {"nodeId": node_id, "kind": "hardware", "hardwareId": hardware_id, "x": 0, "y": 0}


def end(node_id: str, handle: str, bit: int | None = None) -> dict[str, Any]:
    return {"nodeId": node_id, "handle": handle, **({} if bit is None else {"bit": bit})}


def view(
    *links: tuple[dict[str, Any], dict[str, Any]], widgets: dict[str, str] | None = None
) -> dict[str, Any]:
    nodes = [node("relay", "RELAY"), node("ao", "AO"), node("dut", "DUT"), node("off", "OFFLINE")]
    nodes += [node(key, widget=value) for key, value in (widgets or {}).items()]
    return parse_signal_view(
        {
            "nodes": nodes,
            "links": [
                {"linkId": f"L{index}", "from": a, "to": b} for index, (a, b) in enumerate(links)
            ],
        }
    )


def test_valid_view_with_carriers_displays_and_controls() -> None:
    validate(
        view(
            (end("relay", "relay", 3), end("dut", "enable")),
            (end("ao", "ao0"), end("dut", "vref")),
            (end("dut", "vref"), end("scope", "in")),
            (end("ao", "ai0"), end("scope", "in")),
            (end("sw", "out"), end("dut", "enable")),
            (end("set", "out"), end("ao", "ao0")),
            (end("relay", "di"), end("lamps", "in")),
            (end("off", "anything"), end("value", "in")),  # streams not known yet: not checked
            widgets={
                "scope": "scope",
                "sw": "switch",
                "set": "setpoint",
                "lamps": "lamps",
                "value": "value",
            },
        ),
        Catalog(),
    )


@pytest.mark.parametrize(
    ("links", "widgets", "message"),
    [
        (((end("relay", "relay"), end("dut", "enable")),), {}, "16-bit bits cannot carry 1-bit"),
        (
            ((end("relay", "di", 0), end("dut", "enable")),),
            {},
            "needs a stream the device can write",
        ),
        (
            (
                (end("relay", "relay", 1), end("dut", "enable")),
                (end("relay", "relay", 2), end("dut", "enable")),
            ),
            {},
            "already carried",
        ),
        (
            ((end("relay", "relay"), end("ao", "ao0")),),
            {},
            "join a device stream to a signal of a passive part",
        ),
        (((end("ao", "ai0"), end("w", "in")),), {"w": "lamps"}, "does not take scalar"),
        (
            ((end("ao", "ai0"), end("w", "in")), (end("ao", "ao0"), end("w", "in"))),
            {"w": "value"},
            "shows one",
        ),
        (((end("w", "out"), end("ao", "ai0")),), {"w": "setpoint"}, "cannot be written"),
        (((end("ao", "ai0"), end("w", "out")),), {"w": "setpoint"}, "flow into displays"),
        (((end("relay", "nope"), end("w", "in")),), {"w": "lamps"}, "has no stream nope"),
        (((end("relay", "relay", 16), end("w", "in")),), {"w": "lamps"}, "has no bit 16"),
        (((end("a", "in"), end("b", "in")),), {"a": "value", "b": "value"}, "not to each other"),
    ],
)
def test_rules(links: Any, widgets: dict[str, str], message: str) -> None:
    with pytest.raises(AppError, match=message):
        validate(view(*links, widgets=widgets), Catalog())


def test_resolve_through_a_passive_signal_and_fill_the_control() -> None:
    linked = view((end("relay", "relay", 3), end("dut", "enable")))
    target = resolve(linked, Catalog(), end("dut", "enable"))
    assert (target["hardwareId"], target["streamId"], target["bit"]) == ("RELAY", "relay", 3)
    assert write_call(target, "setBit", True, None) == (
        "pci1762_set_relay",
        {"hardwareId": "RELAY", "channel": 3, "closed": True},
    )
    direct = resolve(linked, Catalog(), end("relay", "relay"))
    assert write_call(direct, "setMask", 5, None)[1] == {"hardwareId": "RELAY", "mask": 5}
    with pytest.raises(AppError, match="not linked"):
        resolve(linked, Catalog(), end("dut", "vref"))
    with pytest.raises(AppError, match="takes one bit"):
        write_call(direct, "setBit", True, None)
    with pytest.raises(AppError, match="does not write"):
        write_call(direct, "set", 1, None)


async def test_write_goes_through_the_manual_tool_path() -> None:
    projects = Mock(signals=Mock(return_value=view((end("ao", "ao0"), end("dut", "vref")))))
    catalog = Mock(
        find_hardware=HARDWARE.get,
        get_hardware=HARDWARE.get,
        list_hardware=lambda: list(HARDWARE.values()),
    )
    devices = Mock(
        known_streams=STREAMS.get,
        list_tools=Mock(
            return_value=[
                {
                    "deviceId": "S2",
                    "remoteName": "pci6208v_set_voltage",
                    "externalName": "S2__pci6208v_set_voltage",
                }
            ]
        ),
    )
    manual = Mock(invoke_tool=AsyncMock(return_value={"output": {}}))
    app = SignalsApplication(DefaultAuthorizer(), projects, Mock(), catalog, devices, manual)
    await app.write(HUMAN, {"nodeId": "dut", "handle": "vref", "action": "set", "value": 2.5})
    manual.invoke_tool.assert_awaited_once_with(
        HUMAN,
        {
            "hardwareId": "AO",
            "toolName": "S2__pci6208v_set_voltage",
            "arguments": {"hardwareId": "AO", "channel": 0, "volts": 2.5},
            "timeoutMs": 30_000,
        },
    )
    signals = app.catalog_signals(HUMAN)
    assert {item["hardwareId"]: item["known"] for item in signals} == {
        "RELAY": True,
        "AO": True,
        "OFFLINE": False,
        "DUT": True,
    }


async def test_operations_edit_the_project_buffer_and_writes_need_the_tool() -> None:
    saved: dict[str, Any] = {}

    async def update(view: dict[str, Any]) -> dict[str, Any]:
        saved.update(view)
        return {"dirty": True, "file": {"signals": view}}

    projects = Mock(
        signals=Mock(return_value={"nodes": [], "links": []}),
        update_signals_with_layout=AsyncMock(side_effect=update),
    )
    catalog = Mock(
        find_hardware=HARDWARE.get,
        get_hardware=HARDWARE.get,
        list_hardware=lambda: list(HARDWARE.values()),
    )
    devices = Mock(known_streams=STREAMS.get, list_tools=Mock(return_value=[]))
    wiring = Mock()
    app = SignalsApplication(DefaultAuthorizer(), projects, wiring, catalog, devices, Mock())
    assert app.get_document(HUMAN) == {"nodes": [], "links": []}
    edited = await app.apply_operations(
        HUMAN, [{"type": "add_hardware", "hardwareId": "AO", "nodeId": "ao"}]
    )
    assert (
        [item["nodeId"] for item in edited["nodes"]]
        == ["ao"]
        == [item["nodeId"] for item in saved["nodes"]]
    )
    wiring.notify_project_changed.assert_called_once_with()
    panel = await app.apply_operations(HUMAN, [{"type": "default_panel", "hardwareIds": ["RELAY"]}])
    assert [item.get("widget") for item in panel["nodes"]] == [None, "lamps", "switch"]
    # A batch with an operation it cannot apply is refused before anything is saved.
    with pytest.raises(AppError, match="unknown type"):
        await app.apply_operations(HUMAN, [{"type": "teleport"}])
    projects.signals.return_value = view((end("ao", "ao0"), end("dut", "vref")))
    with pytest.raises(AppError, match="does not offer pci6208v_set_voltage"):
        await app.write(HUMAN, {"nodeId": "dut", "handle": "vref", "action": "set", "value": 1})
