"""Connector/pin reference models; each adapter ships its own data.

The pinout is published inside ``/device`` (``pinout``).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

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
    return function("NC", "nc", "not_connected", mode=mode, description=description)


def single_connector_pinout(
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

