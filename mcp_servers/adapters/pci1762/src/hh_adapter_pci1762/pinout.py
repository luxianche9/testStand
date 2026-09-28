"""PCI-1762 CN1 (62-pin) reference: PCI-1762 User Manual Edition 1."""

from __future__ import annotations

from hardwareharness_device_sdk import Pinout, PinFunction, function, single_connector_pinout

SIGNALS = {
    62: "R11_OUT", 61: "R11_COM", 60: "R12_OUT", 59: "R12_COM", 58: "R13_OUT", 57: "R13_COM",
    56: "R14_OUT", 55: "R14_COM", 54: "R15_OUT", 53: "R15_COM", 50: "ECOM3", 49: "ECOM3",
    48: "ECOM2", 47: "ECOM2", 46: "ECOM1", 45: "ECOM1", 44: "ECOM0", 43: "ECOM0",
    42: "R6_OUT", 41: "R6_COM", 40: "R7_OUT", 39: "R7_COM", 38: "R8_OUT", 37: "R8_COM",
    36: "R9_OUT", 35: "R9_COM", 34: "R10_OUT", 33: "R10_COM", 29: "IDI14", 28: "IDI12",
    27: "IDI10", 26: "IDI8", 25: "IDI6", 24: "IDI4", 23: "IDI2", 22: "IDI0",
    21: "R0_OUT", 20: "R0_COM", 19: "R1_OUT", 18: "R1_COM", 17: "R2_OUT", 16: "R2_COM",
    15: "R3_OUT", 14: "R3_COM", 13: "R4_OUT", 12: "R4_COM", 11: "R5_OUT", 10: "R5_COM",
    8: "IDI15", 7: "IDI13", 6: "IDI11", 5: "IDI9", 4: "IDI7", 3: "IDI5", 2: "IDI3", 1: "IDI1",
}


def relay_pins(hardware_id: str, relay: int) -> tuple[str, ...]:
    return tuple(f"{hardware_id}.CN1.{position}" for position, signal in SIGNALS.items()
                 if signal in (f"R{relay}_OUT", f"R{relay}_COM"))


def input_pins(hardware_id: str) -> tuple[str, ...]:
    return tuple(f"{hardware_id}.CN1.{position}" for position, signal in SIGNALS.items() if signal.startswith("IDI"))


def pinout(hardware_id: str) -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {}
    for position, signal in SIGNALS.items():
        if signal.startswith("R"):
            relay = int(signal[1:].split("_", 1)[0])
            functions[position] = (function(signal, "passive", "relay_dry_contact", channel_kind="relay",
                                            channel_index=relay),)
        elif signal.startswith("IDI"):
            functions[position] = (function(signal, "input", "isolated_digital_input", channel_kind="IDI",
                                            channel_index=int(signal[3:])),)
        else:
            functions[position] = (function(signal, "passive", "isolated_input_common", channel_kind="ECOM",
                                            channel_index=int(signal[-1])),)
    return single_connector_pinout(hardware_id, "Advantech", "PCI-1762", 62, functions,
                                   "PCI-1762 User Manual Edition 1")
