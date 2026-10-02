"""PCI-6208V CN1 (37-pin D-sub) reference: ADLINK 6208/6216 Manual Rev. 3.22.

``assets/ports/CN1.svg`` is rendered from this data by :func:`port_diagram` and
``assets/appearance.svg`` by :func:`appearance_diagram` (the adapter tests keep
the shipped files in sync).
"""

from __future__ import annotations

from hardwareharness_device_sdk import (
    PinFunction,
    Pinout,
    PortDiagram,
    attach_port_image,
    dsub,
    function,
    nc,
    render_board,
    render_port,
    single_connector_pinout,
)

AO_POSITIONS = {0: 19, 1: 37, 2: 16, 3: 34, 4: 13, 5: 31, 6: 10, 7: 28}
PORT_IMAGE = "ports/CN1.svg"


def pinout(hardware_id: str) -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {}
    for channel, position in AO_POSITIONS.items():
        functions[position] = (function(f"V{channel}", "output", "analog_voltage", channel_kind="AO", channel_index=channel),)
    for position, channel in {4: 0, 3: 1, 2: 2, 1: 3}.items():
        functions[position] = (function(f"DI{channel}", "input", "digital_logic", channel_kind="DI", channel_index=channel),)
    for position, channel in {23: 0, 22: 1, 21: 2, 20: 3}.items():
        functions[position] = (function(f"DO{channel}", "output", "digital_logic", channel_kind="DO", channel_index=channel),)
    for position in (5, 24):
        functions[position] = (function("GND", "ground", "digital_ground"),)
    for position in (8, 11, 14, 17, 26, 29, 32, 35):
        functions[position] = (function("A.GND", "ground", "analog_ground"),)
    for position, signal in {6: "+5V", 7: "+15V", 25: "-15V"}.items():
        functions[position] = (function(signal, "power", "power_supply"),)
    for position in (9, 12, 15, 18, 27, 30, 33, 36):
        functions[position] = (nc(description="Available only on PCI-6216; not connected on PCI-6208V."),)
    data = single_connector_pinout(hardware_id, "ADLINK", "PCI-6208V", 37, functions,
                                   "ADLINK 6208/6216 Manual Rev. 3.22")
    return attach_port_image(data, "CN1", PORT_IMAGE, port_diagram(data))


def port_diagram(data: Pinout) -> PortDiagram:
    return render_port(data, "CN1", dsub(37), title="ADLINK PCI-6208V  CN1 (37-pin D-sub)")


def appearance_diagram() -> str:
    return render_board("ADLINK PCI-6208V  analog output card", (
        "8 x static AO, +/-10 V (V0..V7)",
        "4 x DI, 4 x DO (TTL) on CN1",
        "no FIFO, no hardware clock",
        "no output readback (setpoints only)",
    ), ("CN1  37-pin D-sub",))
