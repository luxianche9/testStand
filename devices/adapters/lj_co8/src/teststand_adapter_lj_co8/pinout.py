"""LJ-CO-CPCI-8 front-panel DB-37 (male): user manual V1.0, §1.4.2 figure 1-3.

Channel n is a two-terminal capacitor between "Chn In" (pin 20 + 2n) and "Chn Out" (pin 3 + 2n);
pin 19 is GND; every other pin is NC. The manual does not say which terminal is the board side, so
both are passive and either may face the UUT.
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, single_connector_pinout

SOURCE = "LJ-CO-CPCI-8 用户手册 V1.0, 1.4.2 产品接口定义, 图 1-3 (DB-37 公座)"
PIN_COUNT = 37
CHANNELS = 8


def in_pin(channel: int) -> int:
    return 20 + 2 * channel


def out_pin(channel: int) -> int:
    return 3 + 2 * channel


def pinout(hardware_id: str) -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {
        19: (function("GND", "ground", "ground"),),
    }
    for channel in range(CHANNELS):
        functions[in_pin(channel)] = (function(
            f"Ch{channel} In", "passive", "capacitance", channel_kind="C", channel_index=channel,
            description=f"Capacitor {channel} terminal A; the capacitance appears between this pin and Ch{channel} Out."),)
        functions[out_pin(channel)] = (function(
            f"Ch{channel} Out", "passive", "capacitance", channel_kind="C", channel_index=channel,
            description=f"Capacitor {channel} terminal B; the capacitance appears between Ch{channel} In and this pin."),)
    return single_connector_pinout(hardware_id, "Sinoder", "LJ-CO-CPCI-8", PIN_COUNT, functions, SOURCE)
