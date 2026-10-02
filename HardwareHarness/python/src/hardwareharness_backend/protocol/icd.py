"""ICD document model (design §6.2).

An ICD describes one DUT protocol as pure data: how a byte stream splits into frames
(``framing``), how frames are verified (``checksum``, named algorithms only, §6.3), which
``messages`` a frame can be and how their ``fields`` decode, and optional ``encoders`` used to
build frames for sending (§6.5). The Pydantic models below are the schema; :func:`icd_json_schema`
exports it as JSON Schema for editors and the UI.

Conventions (where §6.2 leaves details open):

* Byte offsets are relative to the start of the frame (header included); negative offsets count
  from the end of the frame. Multi-byte values default to big-endian.
* ``lengthCovers``: ``payload`` = bytes after the length field up to the trailer,
  ``from_header`` = bytes after the header to the end of the frame, ``whole`` = the whole frame;
  ``lengthField.adjust`` is added to the computed frame length.
* ``checksum.range`` uses slice semantics (``to`` is exclusive, negative counts from the end); by
  default it covers the frame from byte 0 up to the checksum. ``checksum.offset`` defaults to
  just before the frame suffix (``footer`` or delimiter).
* The transform offset of a field is named ``bias`` because ``offset`` is the byte offset:
  ``value = raw * scale + bias``. ``enum`` maps the raw integer to a label.
* ``expr`` fields are computed from fields decoded earlier in the same message.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PlainSerializer,
    WithJsonSchema,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from . import checksums
from .expr import FieldExpression, compile_expression

NAME_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"
BITS_PATTERN = re.compile(r"^\s*(\d{1,2})\s*(?:\.\.\s*(\d{1,2})\s*)?$")
HEX_TEXT = re.compile(r"^(?:0x)?[0-9A-Fa-f]{2}$")

Endian = Literal["little", "big"]
IntegerType = Literal["u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64"]
FloatType = Literal["f32", "f64"]
FieldType = Literal[
    "u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64", "ascii", "bytes"
]
INTEGER_SIZES: dict[str, int] = {
    "u8": 1, "i8": 1, "u16": 2, "i16": 2, "u32": 4, "i32": 4, "u64": 8, "i64": 8
}  # fmt: skip
FLOAT_SIZES: dict[str, int] = {"f32": 4, "f64": 8}
MAX_FRAME_LENGTH = 65536


def parse_hex(value: Any) -> bytes:
    """Accept ``"AA 55"``, ``"aa55"``, ``"0xAA 0x55"`` or a list of byte values."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, list):
        if not all(isinstance(item, int) and 0 <= item <= 255 for item in value):
            raise ValueError("byte lists must contain integers 0..255")
        return bytes(value)
    if not isinstance(value, str):
        raise ValueError("expected a hex string such as 'AA 55'")
    parts = value.replace(",", " ").split()
    if not parts:
        return b""
    if len(parts) == 1 and not parts[0].lower().startswith("0x"):
        text = parts[0]
        if len(text) % 2:
            raise ValueError(f"hex string {value!r} has an odd number of digits")
        parts = [text[i : i + 2] for i in range(0, len(text), 2)]
    if not parts or not all(HEX_TEXT.match(part) for part in parts):
        raise ValueError(f"invalid hex string {value!r}")
    return bytes(int(part.removeprefix("0x").removeprefix("0X"), 16) for part in parts)


def format_hex(value: bytes) -> str:
    return value.hex(" ").upper()


HexBytes = Annotated[
    bytes,
    BeforeValidator(parse_hex),
    PlainSerializer(format_hex, return_type=str),
    WithJsonSchema({"type": "string", "description": "Hex bytes, e.g. 'AA 55'"}),
]
Name = Annotated[str, Field(pattern=NAME_PATTERN, max_length=64)]


class Model(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


# -- framing -------------------------------------------------------------------------------


class LengthField(Model):
    offset: int = Field(ge=0)
    size: Literal[1, 2, 3, 4] = 1
    endian: Endian = "big"
    adjust: int = 0


class HeaderLengthFraming(Model):
    kind: Literal["header_length"]
    header: HexBytes
    length_field: LengthField
    length_covers: Literal["payload", "from_header", "whole"] = "payload"
    trailer: Literal["checksum", "none"] = "none"
    footer: HexBytes = b""
    max_length: int = Field(default=1024, ge=1, le=MAX_FRAME_LENGTH)

    @field_validator("header")
    @classmethod
    def _header(cls, value: bytes) -> bytes:
        if not value:
            raise ValueError("header_length framing needs a non-empty header")
        return value


class DelimiterFraming(Model):
    kind: Literal["delimiter"]
    delimiter: HexBytes
    max_length: int = Field(default=1024, ge=1, le=MAX_FRAME_LENGTH)

    @field_validator("delimiter")
    @classmethod
    def _delimiter(cls, value: bytes) -> bytes:
        if not value:
            raise ValueError("delimiter framing needs a non-empty delimiter")
        return value


class FixedFraming(Model):
    kind: Literal["fixed"]
    length: int = Field(ge=1, le=MAX_FRAME_LENGTH)
    header: HexBytes = b""

    @model_validator(mode="after")
    def _header_fits(self) -> FixedFraming:
        if len(self.header) > self.length:
            raise ValueError("fixed framing header is longer than the frame")
        return self


class SlipFraming(Model):
    """RFC 1055 SLIP; frames are the unescaped bytes between ``C0`` delimiters."""

    kind: Literal["slip"]
    max_length: int = Field(default=1024, ge=1, le=MAX_FRAME_LENGTH)


class CobsFraming(Model):
    """COBS with a ``00`` delimiter; frames are the decoded bytes."""

    kind: Literal["cobs"]
    max_length: int = Field(default=1024, ge=1, le=MAX_FRAME_LENGTH)


Framing = Annotated[
    HeaderLengthFraming | DelimiterFraming | FixedFraming | SlipFraming | CobsFraming,
    Field(discriminator="kind"),
]


def frame_suffix(framing: Framing | None) -> bytes:
    """Bytes that always end a frame after the checksum (footer or delimiter)."""
    if isinstance(framing, HeaderLengthFraming):
        return framing.footer
    if isinstance(framing, DelimiterFraming):
        return framing.delimiter
    return b""


# -- checksum ------------------------------------------------------------------------------


class ChecksumRange(Model):
    from_: int = Field(default=0, alias="from")
    to: int | None = None


class Checksum(Model):
    algorithm: str
    range: ChecksumRange | None = None
    offset: int | None = None
    endian: Endian = "big"

    @field_validator("algorithm")
    @classmethod
    def _algorithm(cls, value: str) -> str:
        if value not in checksums.ALGORITHMS:
            names = ", ".join(checksums.ALGORITHM_NAMES)
            raise ValueError(f"unknown checksum algorithm {value!r}; choose one of {names}")
        return value

    @property
    def size(self) -> int:
        return checksums.ALGORITHMS[self.algorithm].size


# -- messages ------------------------------------------------------------------------------


class MatchCondition(Model):
    """One condition; a message matches when all of its conditions hold.

    ``offset`` + ``value`` compare an unsigned integer of ``size`` bytes (optionally ``mask``ed)
    read from the frame; ``id`` compares the frame id of ``frames`` transports (§5.4), optionally
    under ``idMask``; ``length`` requires an exact frame length.
    """

    offset: int | None = None
    value: int | None = Field(default=None, ge=0)
    size: Literal[1, 2, 4, 8] = 1
    endian: Endian = "big"
    mask: int | None = Field(default=None, ge=0)
    id: int | None = Field(default=None, ge=0)
    id_mask: int | None = Field(default=None, ge=0)
    length: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _shape(self) -> MatchCondition:
        if (self.offset is None) != (self.value is None):
            raise ValueError("match needs both offset and value")
        if self.offset is None and self.id is None and self.length is None:
            raise ValueError("match needs offset+value, id or length")
        if self.id_mask is not None and self.id is None:
            raise ValueError("match idMask needs id")
        if self.value is not None and self.value >= 1 << (8 * self.size):
            raise ValueError(f"match value does not fit in {self.size} byte(s)")
        return self


class IcdField(Model):
    name: Name
    offset: int | None = None
    type: FieldType | None = None
    endian: Endian = "big"
    length: int | None = Field(default=None, ge=1, le=MAX_FRAME_LENGTH)
    bits: str | None = None
    scale: float | None = None
    bias: float | None = None
    enum: dict[int, str] | None = None
    unit: str | None = None
    expr: str | None = None
    default: int | float | str | None = None
    description: str | None = None

    @model_validator(mode="after")
    def _shape(self) -> IcdField:
        if self.expr is not None:
            if self.offset is not None or self.type is not None or self.bits is not None:
                raise ValueError(f"field {self.name}: expr fields have no offset, type or bits")
            if self.enum is not None:
                raise ValueError(f"field {self.name}: expr fields cannot have enum")
            return self
        if self.offset is None or self.type is None:
            raise ValueError(f"field {self.name}: needs offset and type (or expr)")
        if self.type in {"ascii", "bytes"}:
            if self.length is None:
                raise ValueError(f"field {self.name}: {self.type} fields need length")
            if any(v is not None for v in (self.bits, self.scale, self.bias, self.enum)):
                raise ValueError(f"field {self.name}: {self.type} fields take no transforms")
        elif self.length is not None:
            raise ValueError(f"field {self.name}: length only applies to ascii/bytes")
        if self.bits is not None:
            if self.type not in INTEGER_SIZES:
                raise ValueError(f"field {self.name}: bits only apply to integer types")
            lo, hi = self.bit_range or (0, 0)
            if hi >= 8 * INTEGER_SIZES[self.type]:
                raise ValueError(f"field {self.name}: bits {self.bits!r} exceed {self.type}")
        if self.enum is not None and self.type in FLOAT_SIZES:
            raise ValueError(f"field {self.name}: enum only applies to integer types")
        if self.scale == 0:
            raise ValueError(f"field {self.name}: scale must not be 0")
        return self

    @field_validator("bits")
    @classmethod
    def _bits(cls, value: str | None) -> str | None:
        if value is None:
            return None
        found = BITS_PATTERN.match(value)
        if not found or (found.group(2) and int(found.group(2)) < int(found.group(1))):
            raise ValueError(f"bits must look like '3' or '3..5' (lo..hi), got {value!r}")
        return value

    @property
    def bit_range(self) -> tuple[int, int] | None:
        found = BITS_PATTERN.match(self.bits) if self.bits is not None else None
        if not found:
            return None
        lo = int(found.group(1))
        return lo, int(found.group(2) or lo)

    @property
    def size(self) -> int:
        """Encoded size in bytes (0 for expr fields)."""
        if self.type in INTEGER_SIZES:
            return INTEGER_SIZES[self.type]
        if self.type in FLOAT_SIZES:
            return FLOAT_SIZES[self.type]
        return self.length or 0

    @property
    def numeric(self) -> bool:
        """Whether decoding yields a number that forms a scalar derived stream."""
        return self.expr is not None or self.type in INTEGER_SIZES or self.type in FLOAT_SIZES


def _conditions(value: Any) -> Any:
    return [value] if isinstance(value, dict) else value


class Message(Model):
    name: Name
    description: str | None = None
    match: Annotated[list[MatchCondition], BeforeValidator(_conditions)] = Field(min_length=1)
    fields: list[IcdField] = Field(default_factory=list)

    @model_validator(mode="after")
    def _fields(self) -> Message:
        _check_fields(f"message {self.name}", self.fields)
        return self


def _check_fields(owner: str, fields: list[IcdField]) -> None:
    seen: list[str] = []
    for item in fields:
        if item.name in seen:
            raise ValueError(f"{owner}: duplicate field {item.name!r}")
        if item.expr is not None:
            try:
                compile_expression(item.expr, seen)
            except ValueError as error:
                raise ValueError(f"{owner} field {item.name}: {error}") from None
        seen.append(item.name)


# -- encoders ------------------------------------------------------------------------------


class EncoderTemplate(Model):
    """Constant parts of an outgoing frame.

    ``header`` defaults to the framing header; ``cmd`` is written as a ``cmdSize``-byte unsigned
    integer at ``cmdOffset`` (default: right after the length field, or after the header);
    ``id`` is the frame id for ``frames`` transports; ``length`` is a minimum body length and
    unused bytes are ``fill``.
    """

    header: HexBytes | None = None
    cmd: int | None = Field(default=None, ge=0)
    cmd_offset: int | None = Field(default=None, ge=0)
    cmd_size: Literal[1, 2, 4] = 1
    cmd_endian: Endian = "big"
    id: int | None = Field(default=None, ge=0)
    length: int | None = Field(default=None, ge=0, le=MAX_FRAME_LENGTH)
    fill: int = Field(default=0, ge=0, le=255)


class Encoder(Model):
    name: Name
    description: str | None = None
    template: EncoderTemplate = Field(default_factory=EncoderTemplate)
    fields: list[IcdField] = Field(default_factory=list)

    @model_validator(mode="after")
    def _fields(self) -> Encoder:
        _check_fields(f"encoder {self.name}", self.fields)
        for item in self.fields:
            if item.expr is not None:
                raise ValueError(f"encoder {self.name} field {item.name}: expr is decode-only")
            if item.offset is not None and item.offset < 0:
                raise ValueError(f"encoder {self.name} field {item.name}: offset must be >= 0")
        return self


# -- document ------------------------------------------------------------------------------


class Icd(Model):
    format_version: Literal[1]
    name: Name
    description: str | None = None
    transport: Literal["bytes", "frames"]
    framing: Framing | None = None
    checksum: Checksum | None = None
    messages: list[Message] = Field(default_factory=list)
    encoders: list[Encoder] = Field(default_factory=list)

    @model_validator(mode="after")
    def _document(self) -> Icd:
        if self.transport == "bytes" and self.framing is None:
            raise ValueError("transport 'bytes' needs framing")
        if self.transport == "frames" and self.framing is not None:
            raise ValueError("transport 'frames' carries whole frames; remove framing")
        if not self.messages and not self.encoders:
            raise ValueError("an ICD needs at least one message or encoder")
        for kind, items in (("message", self.messages), ("encoder", self.encoders)):
            names = [item.name for item in items]
            duplicates = sorted({name for name in names if names.count(name) > 1})
            if duplicates:
                raise ValueError(f"duplicate {kind} name(s): {', '.join(duplicates)}")
        for message in self.messages:
            for condition in message.match:
                if condition.id is not None and self.transport != "frames":
                    raise ValueError(f"message {message.name}: id matches need transport frames")
        framing = self.framing
        if isinstance(framing, HeaderLengthFraming):
            if framing.trailer == "checksum" and self.checksum is None:
                raise ValueError("framing trailer 'checksum' needs a checksum section")
            if framing.trailer == "none" and self.checksum is not None:
                raise ValueError("a checksum with header_length framing needs trailer: checksum")
        return self

    def message(self, name: str) -> Message:
        for message in self.messages:
            if message.name == name:
                return message
        raise KeyError(name)

    def encoder(self, name: str) -> Encoder:
        for encoder in self.encoders:
            if encoder.name == name:
                return encoder
        raise KeyError(name)

    def trailer_size(self) -> int:
        """Bytes after the body: checksum (header_length ``trailer: checksum``) plus suffix."""
        size = len(frame_suffix(self.framing))
        if isinstance(self.framing, HeaderLengthFraming) and self.framing.trailer == "checksum":
            assert self.checksum is not None
            size += self.checksum.size
        return size


def field_expressions(fields: list[IcdField]) -> dict[str, FieldExpression]:
    """Compiled ``expr`` of each computed field (already validated by the model)."""
    seen: list[str] = []
    compiled: dict[str, FieldExpression] = {}
    for item in fields:
        if item.expr is not None:
            compiled[item.name] = compile_expression(item.expr, seen)
        seen.append(item.name)
    return compiled


# -- plan/project binding (§6.4) -----------------------------------------------------------


class ProtocolSource(Model):
    hardware_id: str = Field(min_length=1)
    stream_id: str = Field(min_length=1)


class ProtocolBinding(Model):
    """``protocolBindings: [{icd, source: {hardwareId, streamId}, alias}]``."""

    icd: Name
    source: ProtocolSource
    alias: Name


# -- helpers -------------------------------------------------------------------------------


def icd_document(icd: Icd) -> dict[str, Any]:
    """Canonical JSON-compatible form (aliases, hex strings, defaults included)."""
    return icd.model_dump(mode="json", by_alias=True)


def icd_hash(icd: Icd) -> str:
    """``sha256:<hex>`` of the canonical document; recorded in reports for re-decoding."""
    text = json.dumps(icd_document(icd), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def icd_json_schema() -> dict[str, Any]:
    return Icd.model_json_schema(by_alias=True)
