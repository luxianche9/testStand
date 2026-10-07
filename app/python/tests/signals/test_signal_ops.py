from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.contracts.signals import parse_signal_view
from teststand_backend.signals.signal_ops import apply_operations
from teststand_backend.signals.signal_view import validate

from .test_signal_view import HARDWARE, STREAMS


class Catalog:
    def list_hardware(self) -> list[dict[str, Any]]:
        return [HARDWARE[key] for key in ("RELAY", "AO", "OFFLINE", "DUT")]

    def find_hardware(self, hardware_id: str) -> dict[str, Any] | None:
        return HARDWARE.get(hardware_id)

    def known_streams(self, hardware_id: str) -> list[dict[str, Any]] | None:
        return STREAMS.get(hardware_id)


EMPTY: dict[str, Any] = {"nodes": [], "links": []}


def apply(view: dict[str, Any], *operations: dict[str, Any]) -> dict[str, Any]:
    result = apply_operations(view, list(operations), Catalog())
    validate(parse_signal_view(result), Catalog())
    return result


def test_default_panel_gives_every_known_device_a_widget_per_stream() -> None:
    panel = apply(EMPTY, {"type": "default_panel"})
    kinds = [
        node["widget"] if node["kind"] == "widget" else node["hardwareId"]
        for node in panel["nodes"]
    ]
    # Passive parts and devices never connected get no widgets; analog inputs share one scope.
    assert kinds == ["RELAY", "lamps", "switch", "AO", "setpoint", "scope"]
    again = apply(panel, {"type": "default_panel"})
    assert len(again["nodes"]) == len(panel["nodes"])
    only = apply(EMPTY, {"type": "default_panel", "hardwareIds": ["AO"]})
    assert [node.get("hardwareId") for node in only["nodes"]][0] == "AO"
    assert len(only["nodes"]) == 3


def test_a_batch_refers_to_the_ids_it_creates() -> None:
    view = apply(
        EMPTY,
        {"type": "add_hardware", "hardwareId": "AO", "nodeId": "ao"},
        {"type": "add_hardware", "hardwareId": "DUT", "nodeId": "dut", "x": 700, "y": 40},
        {"type": "add_widget", "widget": "value", "nodeId": "v", "label": "AI0"},
        {
            "type": "link",
            "from": {"nodeId": "ao", "handle": "ai0"},
            "to": {"nodeId": "v", "handle": "in"},
        },
        {
            "type": "link",
            "linkId": "vref",
            "from": {"nodeId": "ao", "handle": "ao0"},
            "to": {"nodeId": "dut", "handle": "vref"},
        },
        {"type": "update_widget", "nodeId": "v", "config": {"digits": 3}},
        {"type": "move_node", "nodeId": "v", "x": 400, "width": 200},
    )
    widget = next(node for node in view["nodes"] if node["nodeId"] == "v")
    assert (widget["label"], widget["config"], widget["x"], widget["width"]) == (
        "AI0",
        {"digits": 3},
        400,
        200,
    )
    assert widget["height"] == 96
    assert next(node for node in view["nodes"] if node["nodeId"] == "dut")["x"] == 700
    assert len(view["links"]) == 2
    view = apply(view, {"type": "remove_link", "linkId": "vref"})
    assert len(view["links"]) == 1
    view = apply(view, {"type": "remove_node", "nodeId": "v"})
    assert view["links"] == [] and len(view["nodes"]) == 2
    assert apply(view, {"type": "clear"}) == EMPTY


@pytest.mark.parametrize(
    "operations,message",
    [
        ([{"type": "explode"}], "unknown type explode"),
        ([{"type": "add_hardware"}], "missing 'hardwareId'"),
        ([{"type": "add_hardware", "hardwareId": "NOPE"}], "Unknown hardware NOPE"),
        (
            [
                {"type": "add_hardware", "hardwareId": "AO"},
                {"type": "add_hardware", "hardwareId": "AO"},
            ],
            "already on the signal view",
        ),
        (
            [
                {"type": "add_widget", "widget": "value", "nodeId": "x"},
                {"type": "add_widget", "widget": "value", "nodeId": "x"},
            ],
            "nodeId x is already",
        ),
        ([{"type": "remove_node", "nodeId": "ghost"}], "No node ghost"),
        ([{"type": "remove_link", "linkId": "ghost"}], "No link ghost"),
        (
            [
                {"type": "add_hardware", "hardwareId": "AO", "nodeId": "ao"},
                {"type": "update_widget", "nodeId": "ao"},
            ],
            "is not a widget",
        ),
    ],
)
def test_bad_operations_are_refused(operations: list[dict[str, Any]], message: str) -> None:
    with pytest.raises(AppError, match=message):
        apply_operations(EMPTY, operations, Catalog())


def test_the_input_view_is_left_untouched() -> None:
    view = apply(EMPTY, {"type": "add_hardware", "hardwareId": "AO", "nodeId": "ao"})
    before = repr(view)
    apply_operations(view, [{"type": "clear"}], Catalog())
    assert repr(view) == before
