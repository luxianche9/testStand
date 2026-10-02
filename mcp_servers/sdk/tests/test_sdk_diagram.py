"""Schematic diagrams: layouts, pin positions, direction colours and connector checks."""

from __future__ import annotations

from xml.etree import ElementTree

import pytest

from hardwareharness_device_sdk import (
    attach_port_image,
    dsub,
    dual_row,
    function,
    render_board,
    render_port,
    single_connector_pinout,
)
from hardwareharness_device_sdk.diagram import COLORS, pin_direction, pin_label


def _pinout(count: int = 9):
    functions = {
        1: (function("DO0", "output", "digital_logic"),),
        2: (function("DI0", "input", "digital_logic"),),
        3: (function("TX", "output", "rs232", mode="rs232"), function("TX+", "bidirectional", "rs485", mode="rs485")),
        5: (function("GND", "ground", "ground"),),
    }
    return single_connector_pinout("hw", "Acme", "X-1", count, functions, "Acme X-1 manual rev A")


def test_layouts():
    assert dsub(37).rows == (tuple(range(1, 20)), tuple(range(20, 38)))
    assert dsub(9).offsets == (0.0, 0.5)
    assert [len(row) for row in dsub(15, high_density=True).rows] == [5, 5, 5]
    assert dual_row(68, "SCSI-68").rows[1][0] == 35
    with pytest.raises(ValueError):
        dsub(11)
    with pytest.raises(ValueError):
        dual_row(7)


def test_render_port_positions_and_colours():
    data = _pinout()
    diagram = render_port(data, "CN1", dsub(9), title="Acme X-1  CN1")
    ElementTree.fromstring(diagram.svg)  # well-formed
    assert set(diagram.positions) == set(range(1, 10))
    assert all(0 < x < 1 and 0 < y < 1 for x, y in diagram.positions.values())
    assert diagram.positions[1][1] < diagram.positions[6][1]  # row 1 above row 2
    pins = {pin.position: pin for pin in data.pins}
    assert pin_direction(pins[3]) == "mode-dependent" and pin_label(pins[3]) == "TX / TX+"
    assert pin_direction(pins[4]) == "nc" and pin_label(pins[4]) == "NC"
    assert COLORS["mode-dependent"] in diagram.svg and "not verified" in diagram.svg
    assert render_port(data, "CN1", dsub(9), title="Acme X-1  CN1").svg == diagram.svg  # deterministic


def test_render_port_rejects_mismatched_layout():
    with pytest.raises(ValueError, match="does not cover"):
        render_port(_pinout(15), "CN1", dsub(9), title="t")
    with pytest.raises(ValueError, match="no connector"):
        render_port(_pinout(), "CN9", dsub(9), title="t")


def test_attach_port_image():
    data = _pinout()
    diagram = render_port(data, "CN1", dsub(9), title="t")
    image = attach_port_image(data, "CN1", "ports/CN1.svg", diagram).connectors[0].image
    assert image is not None and image.asset == "ports/CN1.svg"
    assert [position.pinId for position in image.pinPositions] == [f"hw.CN1.{n}" for n in range(1, 10)]
    assert data.connectors[0].image is None  # the input is not modified
    with pytest.raises(ValueError, match="no connector"):
        attach_port_image(data, ["CN1", "CN2"], "ports/CN1.svg", diagram)


def test_render_board():
    svg = render_board("Acme X-1 <card>", ("8 x DO",), ("CN1 9-pin D-sub",))
    root = ElementTree.fromstring(svg)
    assert root.get("width") == "560" and "&lt;card&gt;" in svg and "CN1 9-pin D-sub" in svg
