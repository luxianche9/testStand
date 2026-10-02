"""Frame decoding and frame building against an ICD (design §6.2, §6.5).

Pure functions over ``bytes``: :func:`decode_frame` verifies the checksum, finds the matching
message and decodes its fields; :func:`encode` builds a complete outgoing frame (header, command,
fields, length field, checksum, footer/delimiter and SLIP/COBS wire encoding).
"""

from __future__ import annotations

import math
import struct
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from hardwareharness_backend.contracts.errors import app_error

from . import checksums
from .framing import cobs_encode, slip_encode
from .icd import (
    FLOAT_SIZES,
    INTEGER_SIZES,
    CobsFraming,
    DelimiterFraming,
    FixedFraming,
    HeaderLengthFraming,
    Icd,
    IcdField,
    MatchCondition,
    Message,
    SlipFraming,
    field_expressions,
    frame_suffix,
    parse_hex,
)

Value = int | float | str | bool | None


class DecodeError(ValueError):
    """A frame could not be decoded; ``reason`` names the stage."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class ChecksumResult:
    ok: bool
    expected: int
    actual: int | None


@dataclass(frozen=True)
class DecodedFrame:
    """Result of :func:`decode_frame`.

    ``error`` is ``None`` for a good frame; otherwise one of ``checksum`` (``message`` and
    ``fields`` are still filled when possible, for diagnosis), ``unmatched``, ``short_frame``
    or ``decode``.
    """

    message: str | None
    fields: dict[str, Value] = field(default_factory=dict)
    raw_values: dict[str, int | float] = field(default_factory=dict)
    checksum: ChecksumResult | None = None
    error: str | None = None
    detail: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def checksum_ok(self) -> bool | None:
        return None if self.checksum is None else self.checksum.ok


# -- decoding ------------------------------------------------------------------------------


def verify_checksum(icd: Icd, frame: bytes) -> ChecksumResult | None:
    spec = icd.checksum
    if spec is None:
        return None
    algorithm = checksums.algorithm(spec.algorithm)
    offset = _position(checksum_offset(icd), len(frame))
    start, stop = _checksum_span(icd, len(frame))
    if offset < 0 or offset + algorithm.size > len(frame) or start > stop:
        raise DecodeError("short_frame", f"frame of {len(frame)} bytes is too short for checksum")
    expected = algorithm.compute(frame[start:stop])
    actual = int.from_bytes(frame[offset : offset + algorithm.size], spec.endian)
    return ChecksumResult(expected == actual, expected, actual)


def checksum_offset(icd: Icd) -> int:
    """Checksum position; negative values count from the end of the frame."""
    assert icd.checksum is not None
    if icd.checksum.offset is not None:
        return icd.checksum.offset
    return -(icd.checksum.size + len(frame_suffix(icd.framing)))


def _checksum_span(icd: Icd, length: int) -> tuple[int, int]:
    assert icd.checksum is not None
    spec = icd.checksum.range
    start = _position(spec.from_ if spec else 0, length)
    to = spec.to if spec is not None else None
    stop = _position(checksum_offset(icd) if to is None else to, length)
    return max(start, 0), min(stop, length)


def _position(offset: int, length: int) -> int:
    return offset + length if offset < 0 else offset


def matches(message: Message, frame: bytes, frame_id: int | None = None) -> bool:
    return all(_condition(condition, frame, frame_id) for condition in message.match)


def _condition(condition: MatchCondition, frame: bytes, frame_id: int | None) -> bool:
    if condition.length is not None and len(frame) != condition.length:
        return False
    if condition.id is not None:
        if frame_id is None:
            return False
        mask = condition.id_mask if condition.id_mask is not None else -1
        if frame_id & mask != condition.id & mask:
            return False
    if condition.offset is not None:
        start = _position(condition.offset, len(frame))
        if start < 0 or start + condition.size > len(frame):
            return False
        value = int.from_bytes(frame[start : start + condition.size], condition.endian)
        if condition.mask is not None:
            value &= condition.mask
        return value == condition.value
    return True


def find_message(icd: Icd, frame: bytes, frame_id: int | None = None) -> Message | None:
    """First message (in ICD order) whose conditions all hold."""
    return next((m for m in icd.messages if matches(m, frame, frame_id)), None)


def decode_frame(icd: Icd, frame: bytes, frame_id: int | None = None) -> DecodedFrame:
    """Decode one complete frame; never raises for bad input (errors are in the result)."""
    try:
        checksum = verify_checksum(icd, frame)
    except DecodeError as error:
        return DecodedFrame(None, error=error.reason, detail=str(error))
    message = find_message(icd, frame, frame_id)
    if message is None:
        return DecodedFrame(None, checksum=checksum, error="unmatched")
    try:
        values, raws = decode_fields(message.fields, frame)
    except DecodeError as error:
        return DecodedFrame(message.name, checksum=checksum, error=error.reason, detail=str(error))
    error_name = "checksum" if checksum is not None and not checksum.ok else None
    return DecodedFrame(message.name, values, raws, checksum, error_name)


def decode_fields(
    fields: list[IcdField], frame: bytes
) -> tuple[dict[str, Value], dict[str, int | float]]:
    """Decoded values by name, plus the pre-transform numbers of numeric fields."""
    expressions = field_expressions(fields)
    values: dict[str, Value] = {}
    raws: dict[str, int | float] = {}
    for item in fields:
        if item.name in expressions:
            try:
                result = expressions[item.name].evaluate(values)
            except Exception as error:
                raise DecodeError("decode", f"field {item.name}: {error}") from None
            values[item.name] = result
            if isinstance(result, (int, float)):
                raws[item.name] = int(result) if isinstance(result, bool) else result
            continue
        value, raw = decode_field(item, frame)
        values[item.name] = value
        if raw is not None:
            raws[item.name] = raw
    return values, raws


def decode_field(item: IcdField, frame: bytes) -> tuple[Value, int | float | None]:
    assert item.offset is not None and item.type is not None
    start = _position(item.offset, len(frame))
    stop = start + item.size
    if start < 0 or stop > len(frame):
        raise DecodeError(
            "decode",
            f"field {item.name} needs bytes {start}..{stop - 1} of a {len(frame)}-byte frame",
        )
    chunk = frame[start:stop]
    if item.type == "ascii":
        return chunk.split(b"\x00", 1)[0].decode("ascii", errors="replace").rstrip(), None
    if item.type == "bytes":
        return chunk.hex(), None
    if item.type in FLOAT_SIZES:
        (number,) = struct.unpack(
            ("<" if item.endian == "little" else ">") + _FLOAT[item.type], chunk
        )
        raw: int | float = float(number)
    else:
        unsigned = int.from_bytes(chunk, item.endian)
        bit_range = item.bit_range
        if bit_range is not None:
            lo, hi = bit_range
            raw = (unsigned >> lo) & ((1 << (hi - lo + 1)) - 1)
        else:
            raw = int.from_bytes(chunk, item.endian, signed=item.type.startswith("i"))
    if item.enum is not None:
        assert isinstance(raw, int)
        return item.enum.get(raw, raw), raw
    return _transform(item, raw), raw


_FLOAT = {"f32": "f", "f64": "d"}


def _transform(item: IcdField, raw: int | float) -> int | float:
    if item.scale is None and item.bias is None:
        return raw
    return raw * (1.0 if item.scale is None else item.scale) + (item.bias or 0.0)


# -- encoding ------------------------------------------------------------------------------


@dataclass(frozen=True)
class EncodedFrame:
    encoder: str
    frame: bytes
    """The logical frame (what :func:`decode_frame` sees)."""
    wire: bytes
    """Bytes to send (SLIP/COBS encoded where the framing requires it)."""
    id: int | None = None


def encode(icd: Icd, encoder_name: str, values: Mapping[str, Any]) -> EncodedFrame:
    """Build the frame for ``encoders[encoder_name]`` with the given field values."""
    try:
        encoder = icd.encoder(encoder_name)
    except KeyError:
        raise app_error(
            "invalid_argument", f"ICD {icd.name} has no encoder {encoder_name!r}"
        ) from None
    known = {item.name for item in encoder.fields}
    unknown = sorted(set(values) - known)
    if unknown:
        raise app_error(
            "invalid_argument", f"encoder {encoder_name} has no field(s) {', '.join(unknown)}"
        )
    framing, template = icd.framing, encoder.template
    header = template.header if template.header is not None else _framing_header(icd)
    cmd_offset = template.cmd_offset
    if cmd_offset is None:
        cmd_offset = _body_start(icd, len(header))
    ends = [len(header), template.length or 0]
    if isinstance(framing, HeaderLengthFraming):
        ends.append(framing.length_field.offset + framing.length_field.size)
    if template.cmd is not None:
        ends.append(cmd_offset + template.cmd_size)
    ends += [(item.offset or 0) + item.size for item in encoder.fields]
    checksum_size = icd.checksum.size if icd.checksum else 0
    suffix = frame_suffix(framing)
    trailer = icd.trailer_size() if isinstance(framing, HeaderLengthFraming) else 0
    if not isinstance(framing, HeaderLengthFraming):
        trailer = checksum_size + len(suffix)
    body_length = max(ends)
    if isinstance(framing, FixedFraming):
        if body_length + trailer > framing.length:
            raise app_error(
                "invalid_argument", f"encoder {encoder_name} exceeds the fixed frame length"
            )
        body_length = framing.length - trailer
    frame = bytearray([template.fill]) * (body_length + trailer)
    frame[: len(header)] = header
    if template.cmd is not None:
        _write_int(frame, cmd_offset, template.cmd_size, template.cmd_endian, template.cmd, "cmd")
    for item in encoder.fields:
        value = values.get(item.name, item.default)
        if value is None:
            raise app_error("invalid_argument", f"encoder {encoder_name} needs field {item.name}")
        _encode_field(frame, item, value)
    if suffix:
        frame[len(frame) - len(suffix) :] = suffix
    if isinstance(framing, HeaderLengthFraming):
        _write_length(frame, framing, len(header), trailer)
    if icd.checksum is not None:
        _write_checksum(icd, frame)
    if isinstance(framing, DelimiterFraming) and framing.delimiter in frame[: -len(suffix)]:
        raise app_error("invalid_argument", "encoded frame contains the delimiter")
    data = bytes(frame)
    maximum = getattr(framing, "max_length", None)
    if maximum is not None and len(data) > maximum:
        raise app_error("invalid_argument", f"encoded frame exceeds maxLength {maximum}")
    wire = data
    if isinstance(framing, SlipFraming):
        wire = slip_encode(data)
    elif isinstance(framing, CobsFraming):
        wire = cobs_encode(data)
    return EncodedFrame(encoder_name, data, wire, template.id)


def _framing_header(icd: Icd) -> bytes:
    framing = icd.framing
    if isinstance(framing, (HeaderLengthFraming, FixedFraming)):
        return framing.header
    return b""


def _body_start(icd: Icd, header_length: int) -> int:
    framing = icd.framing
    if isinstance(framing, HeaderLengthFraming):
        return max(header_length, framing.length_field.offset + framing.length_field.size)
    return header_length


def _write_length(
    frame: bytearray, framing: HeaderLengthFraming, header: int, trailer: int
) -> None:
    spec = framing.length_field
    total = len(frame)
    if framing.length_covers == "payload":
        value = total - spec.offset - spec.size - trailer
    elif framing.length_covers == "from_header":
        value = total - header
    else:
        value = total
    _write_int(frame, spec.offset, spec.size, spec.endian, value - spec.adjust, "length field")


def _write_checksum(icd: Icd, frame: bytearray) -> None:
    assert icd.checksum is not None
    algorithm = checksums.algorithm(icd.checksum.algorithm)
    offset = _position(checksum_offset(icd), len(frame))
    start, stop = _checksum_span(icd, len(frame))
    if offset < 0 or offset + algorithm.size > len(frame):
        raise app_error("invalid_argument", "checksum offset lies outside the encoded frame")
    value = algorithm.compute(bytes(frame[start:stop]))
    frame[offset : offset + algorithm.size] = value.to_bytes(algorithm.size, icd.checksum.endian)


def _write_int(
    frame: bytearray, offset: int, size: int, endian: Any, value: int, what: str
) -> None:
    if not 0 <= value < 1 << (8 * size):
        raise app_error("invalid_argument", f"{what} value {value} does not fit in {size} byte(s)")
    frame[offset : offset + size] = value.to_bytes(size, endian)


def _encode_field(frame: bytearray, item: IcdField, value: Any) -> None:
    assert item.offset is not None and item.type is not None
    start, size = item.offset, item.size
    if item.type == "ascii":
        text = str(value).encode("ascii", errors="strict") if _is_ascii(value) else None
        if text is None or len(text) > size:
            raise app_error("invalid_argument", f"field {item.name} needs ASCII of <= {size} chars")
        frame[start : start + size] = text.ljust(size, b"\x00")
        return
    if item.type == "bytes":
        try:
            chunk = parse_hex(value)
        except ValueError as error:
            raise app_error("invalid_argument", f"field {item.name}: {error}") from None
        if len(chunk) != size:
            raise app_error("invalid_argument", f"field {item.name} needs exactly {size} bytes")
        frame[start : start + size] = chunk
        return
    raw = _raw_value(item, value)
    order = "<" if item.endian == "little" else ">"
    if item.type in FLOAT_SIZES:
        frame[start : start + size] = struct.pack(order + _FLOAT[item.type], float(raw))
        return
    integer = int(raw)
    bit_range = item.bit_range
    if bit_range is not None:
        lo, hi = bit_range
        width = hi - lo + 1
        if not 0 <= integer < 1 << width:
            raise app_error(
                "invalid_argument", f"field {item.name} value does not fit bits {item.bits}"
            )
        current = int.from_bytes(frame[start : start + size], item.endian)
        mask = ((1 << width) - 1) << lo
        combined = (current & ~mask) | (integer << lo)
        frame[start : start + size] = combined.to_bytes(size, item.endian)
        return
    signed = item.type.startswith("i")
    low, high = (
        (-(1 << (8 * size - 1)), (1 << (8 * size - 1)) - 1)
        if signed
        else (0, (1 << (8 * size)) - 1)
    )
    if not low <= integer <= high:
        raise app_error(
            "invalid_argument", f"field {item.name} value {integer} is out of {item.type} range"
        )
    frame[start : start + size] = integer.to_bytes(size, item.endian, signed=signed)


def _is_ascii(value: Any) -> bool:
    return isinstance(value, str) and value.isascii()


def _raw_value(item: IcdField, value: Any) -> int | float:
    if isinstance(value, str) and item.enum is not None:
        for key, label in item.enum.items():
            if label == value:
                return key
        raise app_error(
            "invalid_argument",
            f"field {item.name}: {value!r} is not one of {', '.join(item.enum.values())}",
        )
    if isinstance(value, bool):
        value = int(value)
    if not isinstance(value, (int, float)) or (
        isinstance(value, float) and not math.isfinite(value)
    ):
        raise app_error("invalid_argument", f"field {item.name} needs a finite number")
    raw: int | float = value
    if item.scale is not None or item.bias is not None:
        raw = (value - (item.bias or 0.0)) / (1.0 if item.scale is None else item.scale)
    if item.type in INTEGER_SIZES:
        return round(raw)
    return raw
