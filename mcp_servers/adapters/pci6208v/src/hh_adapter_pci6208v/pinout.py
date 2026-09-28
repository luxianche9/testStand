"""PCI-6208V CN1 (37-pin) reference: ADLINK 6208/6216 Manual Rev. 3.22."""

from __future__ import annotations

from hardwareharness_device_sdk import Pinout, PinFunction, function, nc, single_connector_pinout

AO_POSITIONS = {0: 19, 1: 37, 2: 16, 3: 34, 4: 13, 5: 31, 6: 10, 7: 28}


def ao_pin(hardware_id: str, channel: int) -> str:
    return f"{hardware_id}.CN1.{AO_POSITIONS[channel]}"


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
    return single_connector_pinout(hardware_id, "ADLINK", "PCI-6208V", 37, functions, "ADLINK 6208/6216 Manual Rev. 3.22")
