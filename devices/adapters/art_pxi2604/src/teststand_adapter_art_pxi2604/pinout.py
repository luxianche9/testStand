"""PXI2604 DIN41612-128 connector: ART PXI2604 hardware manual V6.00.02, figure 3-2-1.

Relays come in groups of four on three rows each: group g (relays 4g..4g+3) uses rows
32-3g, 31-3g, 30-3g. Row 1 carries GND (A1, D1), TRIG_OUT (B1), TRIG_IN (C1); row 2 is empty.
Positions follow DIN 41612 column order: a1-a32 = 1-32, b = 33-64, c = 65-96, d = 97-128; each
pin's description gives the name printed in the manual (``A32``).
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, multi_connector_pinout, nc

SOURCE = "PXI2604 硬件使用说明书 V6.00.02, 图 3-2-1 连接器引脚定义"
CONNECTOR_TYPE = "DIN41612-128P male"
ROWS = "ABCD"
RELAYS = 40


def position(name: str) -> int:
    """``A32`` -> 32, ``B1`` -> 33, ``D32`` -> 128."""
    return ROWS.index(name[0]) * 32 + int(name[1:])


def table() -> dict[str, str]:
    """Printed pin name -> signal (``NC0``, ``COM0``, ``NO0``, ``GND``, ...)."""
    result = {"A1": "GND", "B1": "TRIG_OUT", "C1": "TRIG_IN", "D1": "GND"}
    for group in range(RELAYS // 4):
        top, k = 32 - 3 * group, 4 * group
        last = k + 3
        result.update({
            f"B{top}": f"NC{k}", f"C{top}": f"COM{k}", f"A{top}": f"NC{last}", f"D{top}": f"NO{k}",
            f"B{top - 1}": f"NC{k + 1}", f"C{top - 1}": f"COM{k + 1}", f"A{top - 1}": f"COM{last}",
            f"D{top - 1}": f"NO{k + 1}",
            f"B{top - 2}": f"NC{k + 2}", f"C{top - 2}": f"COM{k + 2}", f"A{top - 2}": f"NO{last}",
            f"D{top - 2}": f"NO{k + 2}",
        })
    return result


ROLES = {"NC": "normally closed", "COM": "common", "NO": "normally open"}


def functions_of(name: str, signal: str) -> tuple[PinFunction, ...]:
    if signal == "GND":
        return (function(signal, "ground", "ground", description=f"pin {name}"),)
    if signal.startswith("TRIG"):
        direction = "output" if signal == "TRIG_OUT" else "input"
        return (function(signal, direction, "digital_logic", description=f"pin {name}; scan trigger (not used)"),)
    role = signal.rstrip("0123456789")
    relay = int(signal[len(role):])
    return (function(signal, "passive", "relay_dry_contact", channel_kind="relay", channel_index=relay,
                     description=f"pin {name}; relay k{relay} {ROLES[role]} contact"),)


def pinout(hardware_id: str) -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {position(f"{row}2"): (nc(),) for row in ROWS}
    for name, signal in table().items():
        functions[position(name)] = functions_of(name, signal)
    return multi_connector_pinout(hardware_id, "ART Technology", "PXI2604",
                                  [("CN1", CONNECTOR_TYPE, 128, functions)], SOURCE)
