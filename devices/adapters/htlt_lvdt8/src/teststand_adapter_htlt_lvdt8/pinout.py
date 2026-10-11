"""PXI68802W-I DB-62 connector (board R1.1): 8-channel LVDT simulator manual V2.2, table 2-2.

Channel n: EXC_n_P/N (excitation input, pins 1+2n/2+2n), VA_n_P/N (22+2n/23+2n), VB_n_P/N
(43+2n/44+2n). Pins 17-20, 38-41, 59-62 are not connected; 21 and 42 are signal ground on the
isolated model and unconnected on the non-isolated one. The SCSI-68 variant (R1.0, table 2-1) is
not described here; the bench wiring table (EXC_0_P on pin 1, VA_0_P on pin 22) matches R1.1.
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, nc, single_connector_pinout

SOURCE = "8通道LVDT仿真卡使用手册 V2.2, 图 2-3 / 表 2-2 DB-62pin 接口定义表（单板 R1.1）"
PIN_COUNT = 62
CHANNELS = 8
FIRST = {"EXC": 1, "VA": 22, "VB": 43}


def signals() -> dict[int, str]:
    table = {pin: "NC" for pin in (*range(17, 21), *range(38, 42), *range(59, 63))}
    table.update({21: "NC/GND", 42: "NC/GND"})
    for name, first in FIRST.items():
        for channel in range(CHANNELS):
            table[first + 2 * channel] = f"{name}_{channel}_P"
            table[first + 2 * channel + 1] = f"{name}_{channel}_N"
    return table


def functions_of(signal: str) -> tuple[PinFunction, ...]:
    if signal == "NC":
        return (nc(),)
    if signal == "NC/GND":
        return (function("GND", "ground", "signal_ground",
                         description="Signal ground on the isolated model; not connected on the non-isolated one"),)
    name, channel, polarity = signal.split("_")
    if name == "EXC":
        return (function(signal, "input", "lvdt_excitation", channel_kind="LVDT", channel_index=int(channel),
                         description=f"Excitation input {'+' if polarity == 'P' else '-'} (primary coil), ≤ 10 Vrms"),)
    return (function(signal, "output", "lvdt_secondary", channel_kind="LVDT", channel_index=int(channel),
                     description=f"Secondary {name[1]} {'dotted end' if polarity == 'P' else 'common end'}, 0-10 Vrms"),)


def pinout(hardware_id: str) -> Pinout:
    return single_connector_pinout(hardware_id, "HTLT", "PXI68802W-I", PIN_COUNT,
                                   {pin: functions_of(signal) for pin, signal in signals().items()}, SOURCE)
