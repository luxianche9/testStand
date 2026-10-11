"""PXI2355L SCSI-100 connector: ART PCI/PXI 235xL hardware manual V6.00.02, figure 3-3-1, table 3-3-1.

Ports 0-3 are isolated DI (data P0.0-P3.7, common Px.COM), ports 4-7 isolated Darlington source
DO (data P4.0-P7.7, supply Px.VCC, reference Px.GND, P6/P7 also +5V). Even ports sit on pins
1-50, odd ports on the same layout + 50.
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, nc, single_connector_pinout

SOURCE = "PCI/PXI 235xL 硬件使用说明书 V6.00.02, 图 3-3-1 接口定义, 表 3-3-1 管脚功能概述"
PIN_COUNT = 100

LAYOUT: dict[int, list[tuple[str, int]]] = {
    # even port -> (role, count) from its first pin; the odd port above it is the same + 50
    0: [("data", 8), ("COM", 4)],
    2: [("data", 8), ("COM", 4)],
    4: [("data", 8), ("GND", 1), ("VCC", 3)],
    6: [("data", 8), ("GND", 1), ("VCC", 3), ("+5V", 1)],
}
FIRST_PIN = {0: 1, 2: 13, 4: 26, 6: 38}
NC_PINS = (25, 75)


def signals() -> dict[int, str]:
    """Pin -> signal name as printed (``P0.0``, ``P0.COM``, ``P7.VCC``, ``NC``)."""
    table: dict[int, str] = {pin: "NC" for pin in NC_PINS}
    for even, layout in LAYOUT.items():
        for port, offset in ((even, 0), (even + 1, 50)):
            pin = FIRST_PIN[even] + offset
            for role, count in layout:
                for index in range(count):
                    table[pin] = f"P{port}.{index}" if role == "data" else f"P{port}.{role}"
                    pin += 1
    return table


def functions_of(signal: str) -> tuple[PinFunction, ...]:
    if signal == "NC":
        return (nc(),)
    port_text, _, role = signal[1:].partition(".")
    port = int(port_text)
    if role.isdigit():
        line = (port % 4) * 8 + int(role)
        if port < 4:
            return (function(signal, "input", "isolated_digital_input", channel_kind="DI", channel_index=line,
                             description="Bidirectional optocoupler, ±30 V; 1 = current flows (|V| ≥ 5 V)"),)
        return (function(signal, "output", "darlington_source_output", channel_kind="DO", channel_index=line,
                         description="Darlington source from Px.VCC (5-40 V); 500 mA one line, 100 mA all lines"),)
    if role == "COM":
        return (function(signal, "passive", "isolated_input_common"),)
    if role == "GND":
        return (function(signal, "ground", "isolated_output_ground"),)
    if role == "VCC":
        return (function(signal, "power", "isolated_output_supply", description="External 5-40 V for the port"),)
    return (function(signal, "power", "isolated_5v_output", description="4.2-6 V, max 100 mA per port"),)


def pinout(hardware_id: str) -> Pinout:
    return single_connector_pinout(hardware_id, "ART Technology", "PXI2355L", PIN_COUNT,
                                   {pin: functions_of(signal) for pin, signal in signals().items()}, SOURCE)
