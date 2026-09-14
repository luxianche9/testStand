from __future__ import annotations

from copy import deepcopy
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Direction = Literal["input", "output", "bidirectional", "passive", "power", "ground", "nc"]


class PinFunction(BaseModel):
    model_config = ConfigDict(frozen=True)

    signal: str
    direction: Direction
    electricalType: str
    channelKind: str | None = None
    channelIndex: int | None = None
    mode: str | None = None
    description: str = ""


class Pin(BaseModel):
    model_config = ConfigDict(frozen=True)

    pinId: str
    connectorId: str
    position: int
    functions: tuple[PinFunction, ...]


class Connector(BaseModel):
    model_config = ConfigDict(frozen=True)

    connectorId: str
    name: str
    connectorType: str
    gender: str | None = None
    channelIndex: int | None = None
    pinIds: tuple[str, ...]


class ModeDefinition(BaseModel):
    model_config = ConfigDict(frozen=True)

    mode: str
    label: str


class Pinout(BaseModel):
    model_config = ConfigDict(frozen=True)

    hardwareId: str
    manufacturer: str
    model: str
    connectors: tuple[Connector, ...]
    pins: tuple[Pin, ...]
    activeMode: str | None = None
    modeSelection: str | None = None
    modes: tuple[ModeDefinition, ...] = ()
    sources: tuple[str, ...]


class ToolMeta(BaseModel):
    timestamp: str


class ToolError(BaseModel):
    category: str
    message: str
    retryable: bool = False
    details: Any = None


class PinoutResponse(BaseModel):
    ok: bool
    message: str = ""
    data: Pinout | None = None
    error: ToolError | None = None
    meta: ToolMeta


def _function(
    signal: str,
    direction: Direction,
    electrical_type: str,
    *,
    channel_kind: str | None = None,
    channel_index: int | None = None,
    mode: str | None = None,
    description: str = "",
) -> PinFunction:
    return PinFunction(
        signal=signal,
        direction=direction,
        electricalType=electrical_type,
        channelKind=channel_kind,
        channelIndex=channel_index,
        mode=mode,
        description=description,
    )


def _nc(*, mode: str | None = None, description: str = "Not connected on this hardware model.") -> PinFunction:
    return _function("NC", "nc", "not_connected", mode=mode, description=description)


def _single_connector_pinout(
    hardware_id: str,
    manufacturer: str,
    model: str,
    count: int,
    functions: dict[int, tuple[PinFunction, ...]],
    source: str,
) -> Pinout:
    connector_id = f"{hardware_id}.CN1"
    pins = tuple(
        Pin(
            pinId=f"{connector_id}.{position}",
            connectorId=connector_id,
            position=position,
            functions=functions.get(position, (_nc(),)),
        )
        for position in range(1, count + 1)
    )
    connector = Connector(
        connectorId=connector_id,
        name="CN1",
        connectorType=f"{count}-pin",
        pinIds=tuple(pin.pinId for pin in pins),
    )
    return Pinout(
        hardwareId=hardware_id,
        manufacturer=manufacturer,
        model=model,
        connectors=(connector,),
        pins=pins,
        sources=(source,),
    )


def _pci1710l() -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {}
    for offset, channel in enumerate(range(0, 16, 2)):
        functions[68 - offset] = (_function(f"AI{channel}", "input", "analog_voltage", channel_kind="AI", channel_index=channel),)
        functions[56 - offset] = (_function(f"DI{channel}", "input", "digital_logic", channel_kind="DI", channel_index=channel),)
        functions[47 - offset] = (_function(f"DO{channel}", "output", "digital_logic", channel_kind="DO", channel_index=channel),)
    for offset, channel in enumerate(range(1, 16, 2)):
        functions[34 - offset] = (_function(f"AI{channel}", "input", "analog_voltage", channel_kind="AI", channel_index=channel),)
        functions[22 - offset] = (_function(f"DI{channel}", "input", "digital_logic", channel_kind="DI", channel_index=channel),)
        functions[13 - offset] = (_function(f"DO{channel}", "output", "digital_logic", channel_kind="DO", channel_index=channel),)
    for position in (60, 26):
        functions[position] = (_function("AIGND", "ground", "analog_ground"),)
    for position in (48, 39, 14, 5):
        functions[position] = (_function("DGND", "ground", "digital_ground"),)
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
        functions[position] = (_function(signal, direction, electrical_type),)
    for position in (57, 58, 59, 23, 24, 25):
        functions[position] = (_nc(description="Undefined on PCI-1710L; analog output is not fitted."),)
    return _single_connector_pinout(
        "PC1_MCP.PCI1710L_CARD_0",
        "Advantech",
        "PCI-1710L",
        68,
        functions,
        "Advantech PCI-1710 Series User Manual",
    )


def _pci1762() -> Pinout:
    signals = {
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
    functions: dict[int, tuple[PinFunction, ...]] = {}
    for position, signal in signals.items():
        if signal.startswith("R"):
            relay = int(signal[1:].split("_", 1)[0])
            functions[position] = (_function(signal, "passive", "relay_dry_contact", channel_kind="relay", channel_index=relay),)
        elif signal.startswith("IDI"):
            channel = int(signal[3:])
            functions[position] = (_function(signal, "input", "isolated_digital_input", channel_kind="IDI", channel_index=channel),)
        else:
            channel = int(signal[-1])
            functions[position] = (_function(signal, "passive", "isolated_input_common", channel_kind="ECOM", channel_index=channel),)
    return _single_connector_pinout(
        "PC1_MCP.PCI1762_CARD_0",
        "Advantech",
        "PCI-1762",
        62,
        functions,
        "PCI-1762 User Manual Edition 1",
    )


def _pci6208v() -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {}
    for position, channel in {19: 0, 37: 1, 16: 2, 34: 3, 13: 4, 31: 5, 10: 6, 28: 7}.items():
        functions[position] = (_function(f"V{channel}", "output", "analog_voltage", channel_kind="AO", channel_index=channel),)
    for position, channel in {4: 0, 3: 1, 2: 2, 1: 3}.items():
        functions[position] = (_function(f"DI{channel}", "input", "digital_logic", channel_kind="DI", channel_index=channel),)
    for position, channel in {23: 0, 22: 1, 21: 2, 20: 3}.items():
        functions[position] = (_function(f"DO{channel}", "output", "digital_logic", channel_kind="DO", channel_index=channel),)
    for position in (5, 24):
        functions[position] = (_function("GND", "ground", "digital_ground"),)
    for position in (8, 11, 14, 17, 26, 29, 32, 35):
        functions[position] = (_function("A.GND", "ground", "analog_ground"),)
    for position, signal in {6: "+5V", 7: "+15V", 25: "-15V"}.items():
        functions[position] = (_function(signal, "power", "power_supply"),)
    for position in (9, 12, 15, 18, 27, 30, 33, 36):
        functions[position] = (_nc(description="Available only on PCI-6216; not connected on PCI-6208V."),)
    return _single_connector_pinout(
        "PC1_MCP.PCI6208V_CARD_0",
        "ADLINK",
        "PCI-6208V",
        37,
        functions,
        "ADLINK 6208/6216 Manual Rev. 3.22",
    )


def _cp118u() -> Pinout:
    hardware_id = "PC1_MCP.CP118U_I_CARD_0"
    modes = (
        ModeDefinition(mode="rs232", label="RS-232"),
        ModeDefinition(mode="rs422_rs485_4wire", label="RS-422 / 4-wire RS-485"),
        ModeDefinition(mode="rs485_2wire", label="2-wire RS-485"),
    )
    definitions = {
        "rs232": {1: ("DCD", "input"), 2: ("RxD", "input"), 3: ("TxD", "output"), 4: ("DTR", "output"), 5: ("GND", "ground"), 6: ("DSR", "input"), 7: ("RTS", "output"), 8: ("CTS", "input")},
        "rs422_rs485_4wire": {1: ("TxD-(A)", "output"), 2: ("TxD+(B)", "output"), 3: ("RxD+(B)", "input"), 4: ("RxD-(A)", "input"), 5: ("GND", "ground")},
        "rs485_2wire": {3: ("Data+(B)", "bidirectional"), 4: ("Data-(A)", "bidirectional"), 5: ("GND", "ground")},
    }
    connectors: list[Connector] = []
    pins: list[Pin] = []
    for channel in range(1, 9):
        connector_id = f"{hardware_id}.P{channel}"
        connector_pins: list[str] = []
        for position in range(1, 10):
            pin_id = f"{connector_id}.{position}"
            connector_pins.append(pin_id)
            pin_functions: list[PinFunction] = []
            for mode in (item.mode for item in modes):
                definition = definitions[mode].get(position)
                if definition is None:
                    pin_functions.append(_nc(mode=mode))
                else:
                    signal, direction = definition
                    electrical_type = "signal_ground" if direction == "ground" else "serial_signal"
                    pin_functions.append(_function(signal, direction, electrical_type, channel_kind="serial", channel_index=channel, mode=mode))
            pins.append(Pin(pinId=pin_id, connectorId=connector_id, position=position, functions=tuple(pin_functions)))
        connectors.append(Connector(connectorId=connector_id, name=f"P{channel}", connectorType="DB9", gender="male", channelIndex=channel, pinIds=tuple(connector_pins)))
    return Pinout(
        hardwareId=hardware_id,
        manufacturer="Moxa",
        model="CP-118U-I",
        connectors=tuple(connectors),
        pins=tuple(pins),
        activeMode="unknown",
        modeSelection="hardware_dip",
        modes=modes,
        sources=("Moxa CP-118U/138U Quick Installation Guide v6",),
    )


PINOUTS: dict[str, Pinout] = {
    pinout.hardwareId: pinout
    for pinout in (_pci1710l(), _pci1762(), _pci6208v(), _cp118u())
}


def get_pinout_data(hardware_id: str) -> Pinout:
    pinout = PINOUTS.get(hardware_id)
    if pinout is None:
        raise KeyError(hardware_id)
    return deepcopy(pinout)
