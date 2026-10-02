"""Incremental frame splitting for ``bytes`` transports (design §6.2 ``framing``).

A framer is fed byte chunks in arrival order and returns :class:`FramerEvent` items:

* ``frame``    — one complete frame (for SLIP/COBS: the decoded bytes);
* ``unframed`` — bytes that cannot belong to any frame (skipped while resynchronising, empty
  delimited frames, over-long frames); they are reported, never silently dropped (§6.4
  ``$unframed``);
* ``error``    — a delimited chunk whose framing is invalid (bad SLIP escape, bad COBS code,
  SLIP/COBS payload decoding to more than ``maxLength``); reported so it reaches ``$errors``.

``start``/``end`` are absolute byte positions in the fed stream so callers can map events back
to the raw records that carried them. Framers are deterministic: the same chunks give the same
events regardless of how the bytes were split into chunks, except that ``unframed`` runs are
reported per chunk.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from .icd import (
    CobsFraming,
    DelimiterFraming,
    FixedFraming,
    Framing,
    HeaderLengthFraming,
    SlipFraming,
)

SLIP_END, SLIP_ESC, SLIP_ESC_END, SLIP_ESC_ESC = 0xC0, 0xDB, 0xDC, 0xDD
EventKind = Literal["frame", "unframed", "error"]


@dataclass(frozen=True)
class FramerEvent:
    kind: EventKind
    data: bytes
    start: int
    end: int
    reason: str | None = None


class Framer(Protocol):
    def feed(self, chunk: bytes) -> list[FramerEvent]: ...

    def reset(self, reason: str) -> list[FramerEvent]:
        """Discard buffered bytes (reported as ``unframed``), e.g. at a stream gap."""
        ...

    @property
    def pending(self) -> int: ...


class _Buffered:
    def __init__(self) -> None:
        self._buffer = bytearray()
        self._position = 0  # absolute stream position of _buffer[0]
        self._events: list[FramerEvent] = []

    @property
    def pending(self) -> int:
        return len(self._buffer)

    def feed(self, chunk: bytes) -> list[FramerEvent]:
        self._buffer += chunk
        self._scan()
        events, self._events = self._events, []
        return events

    def reset(self, reason: str) -> list[FramerEvent]:
        self._events = []
        if self._buffer:
            self._take("unframed", len(self._buffer), reason)
        events, self._events = self._events, []
        return events

    def _scan(self) -> None:
        raise NotImplementedError

    def _take(self, kind: EventKind, count: int, reason: str | None = None) -> bytes:
        data = bytes(self._buffer[:count])
        del self._buffer[:count]
        start, self._position = self._position, self._position + count
        if kind == "unframed" and self._events and self._events[-1].kind == "unframed":
            last = self._events.pop()
            data, start, reason = last.data + data, last.start, last.reason
        self._events.append(FramerEvent(kind, data, start, start + len(data), reason))
        return data

    def _drop(self, count: int, reason: str) -> None:
        if count > 0:
            self._take("unframed", count, reason)

    def _keep_prefix(self, marker: bytes) -> int:
        """Length of the longest buffer suffix that could still start ``marker``."""
        for size in range(min(len(marker) - 1, len(self._buffer)), 0, -1):
            if self._buffer.endswith(marker[:size]):
                return size
        return 0


class HeaderLengthFramer(_Buffered):
    def __init__(self, spec: HeaderLengthFraming, trailer_size: int) -> None:
        super().__init__()
        self.spec, self.trailer_size = spec, trailer_size
        field = spec.length_field
        self._length_end = field.offset + field.size
        self._minimum = max(len(spec.header), self._length_end) + trailer_size

    def _frame_length(self) -> int:
        spec, field = self.spec, self.spec.length_field
        value = int.from_bytes(self._buffer[field.offset : self._length_end], field.endian)
        if spec.length_covers == "payload":
            return self._length_end + value + self.trailer_size + field.adjust
        if spec.length_covers == "from_header":
            return len(spec.header) + value + field.adjust
        return value + field.adjust

    def _scan(self) -> None:
        header = self.spec.header
        while self._buffer:
            index = self._buffer.find(header)
            if index < 0:
                self._drop(len(self._buffer) - self._keep_prefix(header), "no_header")
                return
            self._drop(index, "no_header")
            if len(self._buffer) < self._length_end:
                return
            total = self._frame_length()
            if total < self._minimum or total > self.spec.max_length:
                self._drop(1, "bad_length")
                continue
            if len(self._buffer) < total:
                return
            self._take("frame", total)


class DelimiterFramer(_Buffered):
    """Frames end with (and include) the delimiter.

    An over-long frame is discarded as ``unframed`` (reason ``too_long``) up to and including
    its delimiter, without buffering more than ``maxLength`` bytes.
    """

    def __init__(self, spec: DelimiterFraming) -> None:
        super().__init__()
        self.spec = spec
        self._discarding = False

    def reset(self, reason: str) -> list[FramerEvent]:
        self._discarding = False
        return super().reset(reason)

    def _scan(self) -> None:
        delimiter, maximum = self.spec.delimiter, self.spec.max_length
        while self._buffer:
            index = self._buffer.find(delimiter)
            if index < 0:
                keep = self._keep_prefix(delimiter)
                if self._discarding or len(self._buffer) - keep + len(delimiter) > maximum:
                    self._discarding = True
                    self._drop(len(self._buffer) - keep, "too_long")
                return
            total = index + len(delimiter)
            if self._discarding or total > maximum:
                self._discarding = False
                self._drop(total, "too_long")
            elif index == 0:
                self._drop(total, "empty")
            else:
                self._take("frame", total)


class FixedFramer(_Buffered):
    def __init__(self, spec: FixedFraming) -> None:
        super().__init__()
        self.spec = spec

    def _scan(self) -> None:
        header = self.spec.header
        while self._buffer:
            if header:
                index = self._buffer.find(header)
                if index < 0:
                    self._drop(len(self._buffer) - self._keep_prefix(header), "no_header")
                    return
                self._drop(index, "no_header")
            if len(self._buffer) < self.spec.length:
                return
            self._take("frame", self.spec.length)


class _Delimited(_Buffered):
    """Base for SLIP/COBS: split on a delimiter byte, then decode the chunk.

    An encoded chunk longer than ``2 * maxLength + 2`` bytes cannot decode to ``maxLength``
    bytes or fewer; it is discarded as ``unframed`` (``too_long``) through its delimiter without
    being buffered. Shorter chunks that decode too long are ``error`` events.
    """

    delimiter = 0

    def __init__(self, max_length: int) -> None:
        super().__init__()
        self.max_length = max_length
        self._limit = 2 * max_length + 2
        self._discarding = False

    def reset(self, reason: str) -> list[FramerEvent]:
        self._discarding = False
        return super().reset(reason)

    def _decode(self, chunk: bytes) -> bytes:
        raise NotImplementedError

    def _scan(self) -> None:
        while self._buffer:
            index = self._buffer.find(self.delimiter)
            if index < 0:
                if self._discarding or len(self._buffer) > self._limit:
                    self._discarding = True
                    self._drop(len(self._buffer), "too_long")
                return
            if self._discarding or index > self._limit:
                self._discarding = False
                self._drop(index + 1, "too_long")
                continue
            if index == 0:
                # a bare delimiter separates frames; it carries no data
                del self._buffer[:1]
                self._position += 1
                continue
            chunk = bytes(self._buffer[:index])
            try:
                decoded = self._decode(chunk)
            except ValueError as error:
                self._take("error", index + 1, str(error))
                continue
            if len(decoded) > self.max_length:
                self._take("error", index + 1, "too_long")
                continue
            start = self._position
            del self._buffer[: index + 1]
            self._position += index + 1
            self._events.append(FramerEvent("frame", decoded, start, self._position))


class SlipFramer(_Delimited):
    delimiter = SLIP_END

    def _decode(self, chunk: bytes) -> bytes:
        return slip_decode(chunk)


class CobsFramer(_Delimited):
    delimiter = 0x00

    def _decode(self, chunk: bytes) -> bytes:
        return cobs_decode(chunk)


def make_framer(framing: Framing, trailer_size: int = 0) -> Framer:
    if isinstance(framing, HeaderLengthFraming):
        return HeaderLengthFramer(framing, trailer_size)
    if isinstance(framing, DelimiterFraming):
        return DelimiterFramer(framing)
    if isinstance(framing, FixedFraming):
        return FixedFramer(framing)
    if isinstance(framing, SlipFraming):
        return SlipFramer(framing.max_length)
    assert isinstance(framing, CobsFraming)
    return CobsFramer(framing.max_length)


# -- SLIP / COBS codecs --------------------------------------------------------------------


def slip_encode(data: bytes) -> bytes:
    out = bytearray([SLIP_END])
    for byte in data:
        if byte == SLIP_END:
            out += bytes([SLIP_ESC, SLIP_ESC_END])
        elif byte == SLIP_ESC:
            out += bytes([SLIP_ESC, SLIP_ESC_ESC])
        else:
            out.append(byte)
    out.append(SLIP_END)
    return bytes(out)


def slip_decode(chunk: bytes) -> bytes:
    """Unescape one SLIP frame body (without the ``C0`` delimiters)."""
    out = bytearray()
    escaped = False
    for byte in chunk:
        if escaped:
            if byte == SLIP_ESC_END:
                out.append(SLIP_END)
            elif byte == SLIP_ESC_ESC:
                out.append(SLIP_ESC)
            else:
                raise ValueError("bad_escape")
            escaped = False
        elif byte == SLIP_ESC:
            escaped = True
        else:
            out.append(byte)
    if escaped:
        raise ValueError("bad_escape")
    return bytes(out)


def cobs_encode(data: bytes) -> bytes:
    """COBS-encode ``data`` and append the ``00`` delimiter."""
    out = bytearray([0])
    code_index, code = 0, 1
    for byte in data:
        if byte == 0:
            out[code_index] = code
            code_index, code = len(out), 1
            out.append(0)
            continue
        out.append(byte)
        code += 1
        if code == 0xFF:
            out[code_index] = code
            code_index, code = len(out), 1
            out.append(0)
    out[code_index] = code
    out.append(0)
    return bytes(out)


def cobs_decode(chunk: bytes) -> bytes:
    """Decode one COBS frame (without the ``00`` delimiter)."""
    if 0 in chunk:
        raise ValueError("bad_cobs")
    out = bytearray()
    index = 0
    while index < len(chunk):
        code = chunk[index]
        block = chunk[index + 1 : index + code]
        if len(block) != code - 1:
            raise ValueError("bad_cobs")
        out += block
        index += code
        if code != 0xFF and index < len(chunk):
            out.append(0)
    return bytes(out)
