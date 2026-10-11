"""Connector/pin reference models; each adapter ships its own data.

The pinout is published inside ``/device`` (``pinout``): the physical connectors of the
hardware and what every pin carries, taken from the manufacturer's connector table. testStand
uses it to record and plan wiring (which pin connects to which pin of a UUT or fixture). Pins
are never linked to tools or streams.

Build it with :func:`function` (one role of a pin) and :func:`single_connector_pinout` (one
connector numbered 1..count) or :func:`multi_connector_pinout` (several connectors). Positions
without an entry are published as not connected (:func:`nc`). Never guess a pin: an adapter
whose manual has no connector table returns ``None`` from ``Device.pinout`` (not supported).

Example (a 37-pin D-sub, two pins)::

    FUNCTIONS = {
        1: (function("DO0", "output", "digital_logic", channel_kind="DO", channel_index=0),),
        19: (function("GND", "ground", "ground"),),
    }
    def pinout(hardware_id): return single_connector_pinout(
        hardware_id, "Acme", "DIO-32", 37, FUNCTIONS, "Acme DIO-32 manual rev B, table 3-1")
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

Direction = Literal["input", "output", "bidirectional", "passive", "power", "ground", "nc"]


class PinFunction(BaseModel):
    """One role of a pin; a pin with mode-dependent roles has one function per ``mode``."""

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
    """The ``/device`` pinout: connectors, their pins, optional modes and the cited sources."""

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
    connectorView: str = "unknown; verify the connector view in the cited manufacturer manual"
    hardwareRevision: str = "unknown"


def function(
    signal: str,
    direction: Direction,
    electrical_type: str,
    *,
    channel_kind: str | None = None,
    channel_index: int | None = None,
    mode: str | None = None,
    description: str = "",
) -> PinFunction:
    """One role of a pin.

    ``signal`` is the name printed in the manual (``DO0``, ``TXD+``, ``AGND``); ``direction`` is
    seen from the device (``input``, ``output``, ``bidirectional``, ``passive``, ``power``,
    ``ground``, ``nc``); ``electrical_type`` a short free text such as ``digital_logic``,
    ``analog_voltage``, ``rs422_differential``, ``relay_contact``, ``ground``.
    ``channel_kind``/``channel_index`` name the channel the pin belongs to (``"DO"``, 0), as the
    tools number it; ``mode`` restricts the function to one hardware mode (e.g. ``RS232``).
    """
    return PinFunction(
        signal=signal,
        direction=direction,
        electricalType=electrical_type,
        channelKind=channel_kind,
        channelIndex=channel_index,
        mode=mode,
        description=description,
    )


def nc(*, mode: str | None = None, description: str = "Not connected on this hardware model.") -> PinFunction:
    """A pin that is not connected (the default for every position without an entry)."""
    return function("NC", "nc", "not_connected", mode=mode, description=description)


def single_connector_pinout(
    hardware_id: str,
    manufacturer: str,
    model: str,
    count: int,
    functions: dict[int, tuple[PinFunction, ...]],
    source: str,
) -> Pinout:
    """A pinout with one connector ``CN1`` whose pins are numbered ``1..count``.

    ``functions`` maps a pin position to its functions; ``source`` cites the manual (title,
    revision, table). Pin ids are ``<hardware_id>.CN1.<position>``.
    """
    connector_id = f"{hardware_id}.CN1"
    pins = tuple(
        Pin(
            pinId=f"{connector_id}.{position}",
            connectorId=connector_id,
            position=position,
            functions=functions.get(position, (nc(),)),
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



def multi_connector_pinout(
    hardware_id: str,
    manufacturer: str,
    model: str,
    connectors: list[tuple[str, str, int, dict[int, tuple[PinFunction, ...]]]],
    source: str,
) -> Pinout:
    """A pinout with several connectors.

    ``connectors`` lists ``(name, connector_type, count, functions)`` in panel order, e.g.
    ``[("P1", "DB9 male", 9, {2: (function("RXD", "input", "rs232"),), ...}),
    ("P2", "DB9 male", 9, {...})]``; ``name`` is printed on the panel or in the manual and must
    be unique. Pin ids are ``<hardware_id>.<name>.<position>``; positions without an entry are
    not connected.
    """
    names = [name for name, *_ in connectors]
    if len(set(names)) != len(names) or not names:
        raise ValueError("connector names must be unique and at least one connector is needed")
    built: list[Connector] = []
    pins: list[Pin] = []
    for name, connector_type, count, functions in connectors:
        connector_id = f"{hardware_id}.{name}"
        own = [
            Pin(
                pinId=f"{connector_id}.{position}",
                connectorId=connector_id,
                position=position,
                functions=functions.get(position, (nc(),)),
            )
            for position in range(1, count + 1)
        ]
        pins.extend(own)
        built.append(
            Connector(
                connectorId=connector_id,
                name=name,
                connectorType=connector_type,
                pinIds=tuple(pin.pinId for pin in own),
            )
        )
    return Pinout(
        hardwareId=hardware_id,
        manufacturer=manufacturer,
        model=model,
        connectors=tuple(built),
        pins=tuple(pins),
        sources=(source,),
    )
