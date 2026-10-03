"""Derived field streams (design §6.4).

:class:`ProtocolDecoder` turns the records of one raw ``bytes``/``frames`` stream into derived
records for the streams named after the binding alias:

* ``<alias>.<message>`` (``frames``-like): ``{t, tb?, seq, seqFrom?, op?, dir, id?, message,
  fields, raw, checksumOk}`` — only frames that matched, decoded and passed the checksum;
* ``<alias>.<message>.<field>`` (``scalar``): ``{t, tb?, seq, op?, v}`` for numeric fields
  (enum fields carry their raw integer);
* ``<alias>.$errors`` (``frames``-like): frames that failed the checksum, matched no message,
  were too short or failed framing, with ``reason`` and whatever could be decoded;
* ``<alias>.$unframed`` (``bytes``): ``{t, seq, seqFrom?, op?, dir, data, reason}`` bytes that
  could not be split into frames.

Derived records inherit ``t``/``tb``/``op`` of the raw record that completed them; ``seq`` is
that raw record's ``seq`` (``seqFrom`` the first contributing record when a frame spans several).
Watermarks and gaps pass through unchanged (:meth:`ProtocolDecoder.on_event`); a gap discards
partially buffered bytes into ``$unframed`` so no frame is stitched across missing data.
Decoding is deterministic: the same raw records and ICD always give the same derived records,
so recordings keep only raw data and re-decode (:func:`decode_records`).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from teststand_backend.contracts.errors import app_error

from .codec import DecodedFrame, decode_frame
from .framing import Framer, FramerEvent, make_framer
from .icd import Icd

Record = dict[str, Any]
ERRORS, UNFRAMED = "$errors", "$unframed"
DIRECTIONS = ("rx", "tx")
ALIAS = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_INHERITED = ("t", "tb", "op")


@dataclass(frozen=True)
class DerivedStream:
    """Static description of one derived stream (for validation, UI and live display)."""

    stream_id: str
    stream_type: Literal["frames", "scalar", "bytes"]
    message: str | None = None
    field: str | None = None
    unit: str | None = None
    label: str | None = None


@dataclass(frozen=True)
class DerivedRecord:
    stream_id: str
    record: Record


def derived_streams(icd: Icd, alias: str) -> list[DerivedStream]:
    check_alias(alias)
    streams: list[DerivedStream] = []
    for message in icd.messages:
        base = f"{alias}.{message.name}"
        streams.append(DerivedStream(base, "frames", message.name, label=message.description))
        streams += [
            DerivedStream(
                f"{base}.{item.name}",
                "scalar",
                message.name,
                item.name,
                item.unit,
                item.description,
            )
            for item in message.fields
            if item.numeric
        ]
    streams.append(DerivedStream(f"{alias}.{ERRORS}", "frames", label="Undecodable frames"))
    if icd.transport == "bytes":
        streams.append(DerivedStream(f"{alias}.{UNFRAMED}", "bytes", label="Unframed bytes"))
    return streams


def check_alias(alias: str) -> None:
    if not ALIAS.match(alias):
        raise app_error("invalid_argument", f"Invalid protocol alias {alias!r}")


class _Direction:
    def __init__(self, framer: Framer) -> None:
        self.framer = framer
        self.fed = 0
        self.spans: list[tuple[int, int]] = []  # (absolute start position, raw seq)
        self.last: Record | None = None

    def seq_at(self, position: int) -> int | None:
        found = None
        for start, seq in self.spans:
            if start > position:
                break
            found = seq
        return found

    def prune(self) -> None:
        keep_from = self.fed - self.framer.pending
        while len(self.spans) > 1 and self.spans[1][0] <= keep_from:
            self.spans.pop(0)


class ProtocolDecoder:
    """Stateful decoder for one protocol binding (one ICD on one raw stream)."""

    def __init__(self, icd: Icd, alias: str) -> None:
        check_alias(alias)
        self.icd, self.alias = icd, alias
        self.streams = derived_streams(icd, alias)
        self._numeric = {
            message.name: [item for item in message.fields if item.numeric]
            for message in icd.messages
        }
        self._directions: dict[str, _Direction] = {}

    # -- record level --------------------------------------------------------------------

    def feed(self, record: Mapping[str, Any]) -> list[DerivedRecord]:
        """Decode one raw record (``bytes``: ``{dir, data}``; ``frames``: ``{dir, id, data}``)."""
        direction = str(record.get("dir") or "rx")
        if direction not in DIRECTIONS:
            return []  # ``mark`` records annotate the stream and carry no DUT bytes
        try:
            data = bytes.fromhex(str(record.get("data") or ""))
        except ValueError:
            return [self._error(record, direction, b"", "bad_hex", detail=str(record.get("data")))]
        if self.icd.transport == "frames":
            frame_id = record.get("id")
            decoded = decode_frame(self.icd, data, frame_id if isinstance(frame_id, int) else None)
            return self._decoded(record, direction, data, decoded, None, frame_id)
        state = self._direction(direction)
        state.spans.append((state.fed, int(record.get("seq", 0))))
        state.fed += len(data)
        state.last = dict(record)
        out: list[DerivedRecord] = []
        for event in state.framer.feed(data):
            out += self._event(record, direction, state, event)
        state.prune()
        return out

    def gap(self, reason: str = "gap") -> list[DerivedRecord]:
        """Drop partially buffered bytes (reported as ``$unframed``) before missing data."""
        out: list[DerivedRecord] = []
        for direction, state in self._directions.items():
            if state.last is None:
                continue
            for event in state.framer.reset(reason):
                out += self._event(state.last, direction, state, event)
            state.spans = []
        return out

    def flush(self) -> list[DerivedRecord]:
        """Report bytes still buffered at the end of the data as ``$unframed``."""
        return self.gap("incomplete")

    # -- hub event level -----------------------------------------------------------------

    def on_event(self, event: Mapping[str, Any]) -> list[Record]:
        """Map one hub event (``StreamSource.events``) to derived events.

        ``batch`` becomes ``{type: batch, streams: {streamId: [records]}, watermark}`` (the
        watermark applies to every derived stream); ``gap`` first yields a batch with the
        ``$unframed`` remainder, then the gap itself; other events pass through unchanged.
        """
        kind = event.get("type")
        if kind == "batch":
            derived: list[DerivedRecord] = []
            for record in event.get("records") or []:
                derived += self.feed(record)
            return [_batch(derived, event.get("watermark"))]
        if kind == "gap":
            remainder = self.gap(str(event.get("reason") or "gap"))
            return ([_batch(remainder, None)] if remainder else []) + [dict(event)]
        return [dict(event)]

    # -- internals -----------------------------------------------------------------------

    def _direction(self, direction: str) -> _Direction:
        state = self._directions.get(direction)
        if state is None:
            assert self.icd.framing is not None
            framer = make_framer(self.icd.framing, self.icd.trailer_size())
            state = self._directions[direction] = _Direction(framer)
        return state

    def _event(
        self, record: Mapping[str, Any], direction: str, state: _Direction, event: FramerEvent
    ) -> list[DerivedRecord]:
        seq_from = state.seq_at(event.start)
        if event.kind == "unframed":
            body = self._base(record, direction, seq_from)
            body.update(data=event.data.hex(), reason=event.reason)
            return [DerivedRecord(f"{self.alias}.{UNFRAMED}", body)]
        if event.kind == "error":
            return [self._error(record, direction, event.data, "framing", event.reason, seq_from)]
        decoded = decode_frame(self.icd, event.data)
        return self._decoded(record, direction, event.data, decoded, seq_from, None)

    def _decoded(
        self,
        record: Mapping[str, Any],
        direction: str,
        frame: bytes,
        decoded: DecodedFrame,
        seq_from: int | None,
        frame_id: Any,
    ) -> list[DerivedRecord]:
        body = self._base(record, direction, seq_from)
        if frame_id is not None:
            body["id"] = frame_id
        if not decoded.ok:
            body.update(reason=decoded.error, raw=frame.hex(), checksumOk=decoded.checksum_ok)
            if decoded.message is not None:
                body.update(message=decoded.message, fields=decoded.fields)
            if decoded.detail is not None:
                body["detail"] = decoded.detail
            return [DerivedRecord(f"{self.alias}.{ERRORS}", body)]
        assert decoded.message is not None
        body.update(
            message=decoded.message,
            fields=decoded.fields,
            raw=frame.hex(),
            checksumOk=decoded.checksum_ok,
        )
        base = f"{self.alias}.{decoded.message}"
        out = [DerivedRecord(base, body)]
        scalar_base: Record = {key: body[key] for key in ("t", "tb", "seq", "op") if key in body}
        for item in self._numeric[decoded.message]:
            value = _scalar(decoded.fields.get(item.name), decoded.raw_values.get(item.name))
            if value is not None:
                out.append(DerivedRecord(f"{base}.{item.name}", {**scalar_base, "v": value}))
        return out

    def _error(
        self,
        record: Mapping[str, Any],
        direction: str,
        raw: bytes,
        reason: str,
        detail: str | None = None,
        seq_from: int | None = None,
    ) -> DerivedRecord:
        body = self._base(record, direction, seq_from)
        body.update(reason=reason, raw=raw.hex(), checksumOk=None)
        if detail is not None:
            body["detail"] = detail
        return DerivedRecord(f"{self.alias}.{ERRORS}", body)

    @staticmethod
    def _base(record: Mapping[str, Any], direction: str, seq_from: int | None) -> Record:
        body: Record = {key: record[key] for key in _INHERITED if key in record}
        body["seq"] = record.get("seq")
        if seq_from is not None and seq_from != record.get("seq"):
            body["seqFrom"] = seq_from
        body["dir"] = direction
        return body


def _scalar(value: Any, raw: int | float | None) -> int | float | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    return raw


def _batch(derived: list[DerivedRecord], watermark: Any) -> Record:
    streams: dict[str, list[Record]] = {}
    for item in derived:
        streams.setdefault(item.stream_id, []).append(item.record)
    return {"type": "batch", "streams": streams, "watermark": watermark}


def decode_records(
    icd: Icd,
    alias: str,
    records: Iterable[Mapping[str, Any]],
    *,
    gaps: Iterable[Mapping[str, Any]] = (),
    flush: bool = False,
) -> dict[str, list[Record]]:
    """Offline decoding of recorded raw records (re-judging, ICD trial decoding).

    ``gaps`` are hub/recorder gap intervals ``{t0, t1}`` in the raw stream's service time; the
    decoder resets its buffers at each gap exactly as the online decoder did. With ``flush``,
    bytes still buffered at the end are reported as ``$unframed``.
    """
    decoder = ProtocolDecoder(icd, alias)
    pending = sorted(float(gap.get("t0") or 0.0) for gap in gaps)
    derived: list[DerivedRecord] = []
    for record in records:
        t = float(record.get("t") or 0.0)
        while pending and pending[0] < t:
            pending.pop(0)
            derived += decoder.gap()
        derived += decoder.feed(record)
    if flush:
        derived += decoder.flush()
    grouped: dict[str, list[Record]] = {}
    for item in derived:
        grouped.setdefault(item.stream_id, []).append(item.record)
    return grouped
