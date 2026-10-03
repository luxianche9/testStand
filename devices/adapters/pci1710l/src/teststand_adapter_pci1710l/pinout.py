"""PCI-1710L CN1 (68-pin SCSI) reference: Advantech PCI-1710 Series User Manual."""

from __future__ import annotations

from teststand_device_sdk import (
    PinFunction,
    Pinout,
    function,
    nc,
    single_connector_pinout,
)


def _positions() -> dict[str, dict[int, int]]:
    result: dict[str, dict[int, int]] = {"AI": {}, "DI": {}, "DO": {}}
    for offset, channel in enumerate(range(0, 16, 2)):
        result["AI"][channel], result["DI"][channel], result["DO"][channel] = 68 - offset, 56 - offset, 47 - offset
    for offset, channel in enumerate(range(1, 16, 2)):
        result["AI"][channel], result["DI"][channel], result["DO"][channel] = 34 - offset, 22 - offset, 13 - offset
    return result


POSITIONS = _positions()


def pinout(hardware_id: str) -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {}
    kinds = {"AI": ("input", "analog_voltage"), "DI": ("input", "digital_logic"), "DO": ("output", "digital_logic")}
    for kind, (direction, electrical_type) in kinds.items():
        for channel, position in POSITIONS[kind].items():
            functions[position] = (function(f"{kind}{channel}", direction, electrical_type,  # type: ignore[arg-type]
                                            channel_kind=kind, channel_index=channel),)
    for position in (60, 26):
        functions[position] = (function("AIGND", "ground", "analog_ground"),)
    for position in (48, 39, 14, 5):
        functions[position] = (function("DGND", "ground", "digital_ground"),)
    specials = {
        38: ("CNT0_CLK", "input", "counter_clock"),
        37: ("CNT0_OUT", "output", "counter_output"),
        36: ("CNT0_GATE", "input", "counter_gate"),
        4: ("PACER_OUT", "output", "clock_output"),
        3: ("TRG_GATE", "input", "trigger_gate"),
        2: ("EXT_TRG", "input", "external_trigger"),
        35: ("+12V", "power", "power_supply"),
        1: ("+5V", "power", "power_supply"),
    }
    for position, (signal, direction, electrical_type) in specials.items():
        functions[position] = (function(signal, direction, electrical_type),)  # type: ignore[arg-type]
    for position in (57, 58, 59, 23, 24, 25):
        functions[position] = (nc(description="Undefined on PCI-1710L; analog output is not fitted."),)
    return single_connector_pinout(hardware_id, "Advantech", "PCI-1710L", 68, functions,
                                   "Advantech PCI-1710 Series User Manual")
