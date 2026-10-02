"""CP-118U-I: eight male DB9 ports whose electrical mode is set by DIP switch.

Reference: Moxa CP-118U/138U Quick Installation Guide v6.

``assets/ports/DB9.svg`` (shared by P1..P8) is rendered from this data by
:func:`port_diagram` and ``assets/appearance.svg`` by :func:`appearance_diagram`
(the adapter tests keep the shipped files in sync).
"""

from __future__ import annotations

from hardwareharness_device_sdk import (
    Connector,
    ModeDefinition,
    Pin,
    PinFunction,
    Pinout,
    PortDiagram,
    attach_port_image,
    dsub,
    function,
    nc,
    render_board,
    render_port,
)

PORT_IMAGE = "ports/DB9.svg"
PORT_NOTE = ("Labels: RS-232 / RS-422, 4-wire RS-485 / 2-wire RS-485 (per-port DIP switch). Schematic, not to "
             "scale; the view (mating face or solder side) is not verified.")
CHANNELS = range(1, 9)
MODES = (
    ModeDefinition(mode="rs232", label="RS-232"),
    ModeDefinition(mode="rs422_rs485_4wire", label="RS-422 / 4-wire RS-485"),
    ModeDefinition(mode="rs485_2wire", label="2-wire RS-485"),
)
DEFINITIONS: dict[str, dict[int, tuple[str, str]]] = {
    "rs232": {1: ("DCD", "input"), 2: ("RxD", "input"), 3: ("TxD", "output"), 4: ("DTR", "output"),
              5: ("GND", "ground"), 6: ("DSR", "input"), 7: ("RTS", "output"), 8: ("CTS", "input")},
    "rs422_rs485_4wire": {1: ("TxD-(A)", "output"), 2: ("TxD+(B)", "output"), 3: ("RxD+(B)", "input"),
                          4: ("RxD-(A)", "input"), 5: ("GND", "ground")},
    "rs485_2wire": {3: ("Data+(B)", "bidirectional"), 4: ("Data-(A)", "bidirectional"), 5: ("GND", "ground")},
}


def connector_id(hardware_id: str, channel: int) -> str:
    return f"{hardware_id}.P{channel}"


def port_pins(hardware_id: str, channel: int) -> tuple[str, ...]:
    return tuple(f"{connector_id(hardware_id, channel)}.{position}" for position in range(1, 10))


def pinout(hardware_id: str) -> Pinout:
    connectors: list[Connector] = []
    pins: list[Pin] = []
    for channel in CHANNELS:
        connector = connector_id(hardware_id, channel)
        for position in range(1, 10):
            functions: list[PinFunction] = []
            for mode in (item.mode for item in MODES):
                definition = DEFINITIONS[mode].get(position)
                if definition is None:
                    functions.append(nc(mode=mode))
                else:
                    signal, direction = definition
                    electrical_type = "signal_ground" if direction == "ground" else "serial_signal"
                    functions.append(function(signal, direction, electrical_type,  # type: ignore[arg-type]
                                              channel_kind="serial", channel_index=channel, mode=mode))
            pins.append(Pin(pinId=f"{connector}.{position}", connectorId=connector, position=position,
                            functions=tuple(functions)))
        connectors.append(Connector(connectorId=connector, name=f"P{channel}", connectorType="DB9", gender="male",
                                    channelIndex=channel, pinIds=port_pins(hardware_id, channel)))
    data = Pinout(hardwareId=hardware_id, manufacturer="Moxa", model="CP-118U-I", connectors=tuple(connectors),
                  pins=tuple(pins), activeMode="unknown", modeSelection="hardware_dip", modes=MODES,
                  sources=("Moxa CP-118U/138U Quick Installation Guide v6",))
    return attach_port_image(data, [f"P{channel}" for channel in CHANNELS], PORT_IMAGE, port_diagram(data))


def port_diagram(data: Pinout) -> PortDiagram:
    return render_port(data, "P1", dsub(9), title="Moxa CP-118U-I  P1..P8 (DB9 male, same pinout)", note=PORT_NOTE)


def appearance_diagram() -> str:
    return render_board("Moxa CP-118U-I  8-port isolated serial card", (
        "8 x isolated serial port (P1..P8)",
        "RS-232 / RS-422 / RS-485 per port",
        "mode set by DIP switch, not software",
        "fan-out cable to 8 x DB9 male",
    ), ("multiport connector",))
