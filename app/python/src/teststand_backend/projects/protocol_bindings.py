"""The project's protocol bindings (design §6.4), live.

``project.json`` ``protocols: [{icd, alias, source: {hardwareId, streamId}}]`` puts an ICD on a
raw ``bytes``/``frames`` stream of a device. Each binding derives streams on the source
hardware, named after its alias (:mod:`teststand_backend.protocol.derived`):
``<alias>.<message>.<field>`` (``scalar``), ``<alias>.<message>`` and ``<alias>.$errors``.

They behave like the streams the device declares: :meth:`ProjectProtocols.derived` tells the
stream sources how to compute one (so the live view, ``observe`` and ``expect`` follow it), the
stream lists include the field streams, and every test plan decodes with these bindings.
A binding whose ICD is missing or invalid derives nothing; :meth:`describe` says why.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from typing import Any

from teststand_backend.contracts.errors import AppError
from teststand_backend.protocol import Icd, ProtocolDecoder, derived_streams, icd_hash
from teststand_backend.protocol.derived import DerivedStream
from teststand_backend.streams.source import DerivedSpec

from .icd_library import IcdLibrary

Record = dict[str, Any]
StreamLister = Callable[[str], Awaitable[list[Record]]]


@dataclass(frozen=True)
class _Bound:
    alias: str
    icd: Icd
    hardware_id: str
    stream_id: str
    streams: dict[str, DerivedStream]


class ProjectProtocols:
    def __init__(self, projects: Any, icds: IcdLibrary) -> None:
        self.projects, self.icds = projects, icds

    def bindings(self) -> list[Record]:
        result = self.projects.protocols()
        return result if isinstance(result, list) else []

    def _bound(self) -> list[_Bound]:
        output: list[_Bound] = []
        for binding in self.bindings():
            icd = self.icds.get(binding["icd"])
            if icd is None:
                continue
            source = binding["source"]
            streams = {item.stream_id: item for item in derived_streams(icd, binding["alias"])}
            output.append(
                _Bound(binding["alias"], icd, source["hardwareId"], source["streamId"], streams)
            )
        return output

    def derived(self, hardware_id: str, stream_id: str) -> DerivedSpec | None:
        """How to compute ``stream_id`` of ``hardware_id`` when a binding derives it."""
        for bound in self._bound():
            stream = bound.streams.get(stream_id)
            if bound.hardware_id != hardware_id or stream is None:
                continue
            return DerivedSpec(
                bound.stream_id,
                stream.stream_type,
                partial(ProtocolDecoder, bound.icd, bound.alias),
                _declaration(bound, stream),
            )
        return None

    def streams(self, hardware_id: str) -> list[Record]:
        """The field streams the bindings derive on ``hardware_id``, like declared streams
        (``{id, type, label?, unit?, derived}``). Message and error streams are left out: they
        are followed by name, not shown as signals."""
        return [
            {
                "id": stream.stream_id,
                "type": stream.stream_type,
                **({"label": stream.label} if stream.label else {}),
                **({"unit": stream.unit} if stream.unit else {}),
                "derived": _origin(bound, stream),
            }
            for bound in self._bound()
            if bound.hardware_id == hardware_id
            for stream in bound.streams.values()
            if stream.field is not None
        ]

    def with_derived(self, list_streams: StreamLister) -> StreamLister:
        """``list_streams`` plus the field streams derived on the same hardware."""

        async def listed(hardware_id: str) -> list[Record]:
            return [*await list_streams(hardware_id), *self.streams(hardware_id)]

        return listed

    def describe(self) -> list[Record]:
        """Every binding with its state: ``ok`` and the field streams, or why it derives none."""
        output: list[Record] = []
        for binding in self.bindings():
            entry: Record = {**binding, "ok": False}
            try:
                icd = self.icds.load(binding["icd"])
            except AppError as error:
                entry["error"] = str(error)
                output.append(entry)
                continue
            entry.update(ok=True, icdHash=icd_hash(icd), transport=icd.transport)
            entry["streams"] = [
                {
                    "streamId": item.stream_id,
                    "message": item.message,
                    "field": item.field,
                    **({"unit": item.unit} if item.unit else {}),
                    **({"label": item.label} if item.label else {}),
                }
                for item in derived_streams(icd, binding["alias"])
                if item.field is not None
            ]
            output.append(entry)
        return output


def _origin(bound: _Bound, stream: DerivedStream) -> Record:
    return {
        "icd": bound.icd.name,
        "alias": bound.alias,
        "sourceStreamId": bound.stream_id,
        **({"message": stream.message} if stream.message else {}),
        **({"field": stream.field} if stream.field else {}),
    }


def _declaration(bound: _Bound, stream: DerivedStream) -> Record:
    return {
        **({"label": stream.label} if stream.label else {}),
        **({"unit": stream.unit} if stream.unit else {}),
        "derived": _origin(bound, stream),
    }
