"""JCXD-RS-CPCI-8MI SCSI-68 connector: JCXD-RS-X hardware manual V1.0 §3.3.2, async 8M/8MI tables.

Channel n uses an isolated ground pair GDn, OUTn-/OUTn+ and, 34 pins further, INn+/INn-. What a
pin carries depends on the channel's electrical mode (registry ``RsMode``): RS-232 TX = OUTn-,
RX = INn+; RS-422 TX = OUTn±, RX = INn±; RS-485 data = OUTn± (2-wire). Pins 1 and 35 are digital
ground; on the RS-232 table pins 45/46 are VD3 (channel 3 isolated supply).
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, nc, single_connector_pinout

SOURCE = "JCXD-RS-X 用户手册-硬件 V1.0, §3.3.2 异步 RS232/RS422/RS485（JCXD-RS-CPCI-8MI）"
PIN_COUNT = 68
FIRST_GD = {7: 3, 5: 7, 3: 11, 1: 15, 6: 19, 4: 23, 2: 27, 0: 31}
"""Channel -> first of its two GD pins; OUT- and OUT+ follow, IN+/IN- are OUT-/OUT+ + 34."""


def pins() -> dict[int, tuple[PinFunction, ...]]:
    table: dict[int, tuple[PinFunction, ...]] = {
        1: (function("GND", "ground", "digital_ground"),), 35: (function("GND", "ground", "digital_ground"),),
        2: (nc(),), 36: (nc(),),
    }
    for channel, gd in FIRST_GD.items():
        ground = function(f"GD{channel}", "ground", "isolated_ground", channel_kind="serial", channel_index=channel)
        table[gd] = table[gd + 1] = (ground,)
        out_minus, out_plus = gd + 2, gd + 3

        def role(signal: str, direction: str, mode: str, what: str) -> PinFunction:
            return function(signal, direction, f"{mode.lower()}_line", channel_kind="serial", channel_index=channel,
                            mode=mode, description=what)

        table[out_minus] = (role(f"OUT{channel}-", "output", "RS232", "TXD"),
                            role(f"OUT{channel}-", "output", "RS422", "TX-"),
                            role(f"OUT{channel}-", "bidirectional", "RS485", "D-"))
        table[out_plus] = (role(f"OUT{channel}+", "output", "RS422", "TX+"),
                           role(f"OUT{channel}+", "bidirectional", "RS485", "D+"))
        table[out_minus + 34] = (role(f"IN{channel}+", "input", "RS232", "RXD"),
                                 role(f"IN{channel}+", "input", "RS422", "RX+"))
        table[out_plus + 34] = (role(f"IN{channel}-", "input", "RS422", "RX-"),)
        table[gd + 34] = table[gd + 35] = (nc(),)
    supply = function("VD3", "power", "isolated_supply", channel_kind="serial", channel_index=3, mode="RS232",
                      description="Channel 3 isolated supply (RS-232 table only)")
    table[45] = table[46] = (supply,)
    return table


def pinout(hardware_id: str) -> Pinout:
    return single_connector_pinout(hardware_id, "Devices-JC", "JCXD-RS-CPCI-8MI", PIN_COUNT, pins(), SOURCE)
