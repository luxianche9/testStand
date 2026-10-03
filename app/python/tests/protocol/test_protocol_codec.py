from __future__ import annotations

from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.protocol import (
    Icd,
    checksums,
    decode_frame,
    encode,
    find_message,
    make_framer,
    parse_icd,
    verify_checksum,
)
from teststand_backend.protocol.codec import decode_field
from teststand_backend.protocol.framing import cobs_encode, slip_encode

from .icd_fixtures import ack_frame, dut_cmd, status_frame

DOC_STATUS = bytes.fromhex("aa 55 0e 81 01 d2 04 cc ff 56 31 2e 32 2e 33 00 00 80 7d")


def test_design_example_status_frame() -> None:
    icd = dut_cmd()
    assert status_frame() == DOC_STATUS
    decoded = decode_frame(icd, DOC_STATUS)
    assert decoded.ok and decoded.checksum_ok is True and decoded.message == "status"
    assert decoded.fields == {
        "selfTest": "pass",
        "voltage": pytest.approx(12.34),
        "temp": pytest.approx(-5.2),
        "version": "V1.2.3",
        "selfTestRaw": 1,
        "power": pytest.approx(25.68),
    }
    assert decoded.raw_values["selfTest"] == 1 and decoded.raw_values["voltage"] == 1234
    assert decoded.raw_values["temp"] == -52 and "version" not in decoded.raw_values
    assert find_message(icd, ack_frame(3)) is not None
    ack = decode_frame(icd, ack_frame(3))
    assert (ack.message, ack.fields) == ("ack", {"code": 3})


def test_decode_failures() -> None:
    icd = dut_cmd()
    corrupted = bytearray(DOC_STATUS)
    corrupted[5] ^= 0xFF
    bad = decode_frame(icd, bytes(corrupted))
    assert (bad.error, bad.message, bad.checksum_ok) == ("checksum", "status", False)
    assert bad.fields["selfTest"] == "pass" and not bad.ok
    assert bad.checksum is not None and bad.checksum.actual == 0x7D80

    short = decode_frame(icd, b"\xaa")
    assert (short.error, short.message, short.checksum) == ("short_frame", None, None)
    with pytest.raises(ValueError, match="too short"):
        verify_checksum(icd, b"\xaa")

    unknown = bytearray(ack_frame(1))
    unknown[3] = 0x77
    frame = fix_crc(bytes(unknown))
    assert decode_frame(icd, frame).error == "unmatched"

    truncated = fix_crc(b"\xaa\x55\x04\x81\x01\x02\x03\x00\x00")
    result = decode_frame(icd, truncated)
    assert (result.error, result.message) == ("decode", "status")
    assert result.detail is not None and "version" in result.detail

    # mode_echo needs cmd 0x10 *and* a 7-byte frame
    long_echo = fix_crc(b"\xaa\x55\x03\x10\x02\x00\x00\x00")
    assert decode_frame(icd, long_echo).error == "unmatched"


def fix_crc(frame: bytes) -> bytes:
    body = frame[:-2]
    return body + checksums.compute("crc16_modbus", body[2:]).to_bytes(2, "little")


def test_encode_design_example() -> None:
    icd = dut_cmd()
    encoded = encode(icd, "set_mode", {"mode": 2})
    assert encoded.frame.hex(" ") == "aa 55 02 10 02 5c 01"
    assert encoded.wire == encoded.frame and encoded.id is None
    decoded = decode_frame(icd, encoded.frame)
    assert (decoded.message, decoded.fields) == ("mode_echo", {"mode": 2})
    framer = make_framer(icd.framing, icd.trailer_size())  # type: ignore[arg-type]
    assert [event.data for event in framer.feed(encoded.wire)] == [encoded.frame]


@pytest.mark.parametrize(
    ("name", "values", "needle"),
    [
        ("nope", {}, "no encoder"),
        ("set_mode", {}, "needs field mode"),
        ("set_mode", {"mode": 1, "speed": 2}, "no field(s) speed"),
        ("set_mode", {"mode": 256}, "out of u8 range"),
        ("set_mode", {"mode": "fast"}, "finite number"),
        ("set_mode", {"mode": float("nan")}, "finite number"),
    ],
)
def test_encode_errors(name: str, values: dict[str, Any], needle: str) -> None:
    with pytest.raises(AppError) as caught:
        encode(dut_cmd(), name, values)
    assert caught.value.category == "invalid_argument"
    assert needle in str(caught.value)


RICH: dict[str, Any] = {
    "formatVersion": 1,
    "name": "rich",
    "transport": "frames",
    "checksum": {"algorithm": "xor8"},
    "messages": [
        {
            "name": "telemetry",
            "match": [{"offset": 0, "value": 0x42}, {"id": 0x123}],
            "fields": [
                {
                    "name": "mode",
                    "offset": 1,
                    "type": "u8",
                    "bits": "0..2",
                    "enum": {0: "idle", 1: "run", 5: "fault"},
                },
                {"name": "alarm", "offset": 1, "type": "u8", "bits": "7"},
                {"name": "rpm", "offset": 2, "type": "u16", "scale": 0.5, "unit": "rpm"},
                {
                    "name": "pos",
                    "offset": 4,
                    "type": "i32",
                    "endian": "little",
                    "scale": 0.001,
                    "bias": -100,
                },
                {"name": "gain", "offset": 8, "type": "f32"},
                {"name": "ratio", "offset": 12, "type": "f64", "endian": "little", "default": 0.25},
                {"name": "tag", "offset": 20, "type": "bytes", "length": 2},
                {"name": "label", "offset": 22, "type": "ascii", "length": 3},
                {"name": "rpm2", "expr": "rpm * 2 if alarm == 1 else -1"},
            ],
        },
        {"name": "other", "match": {"id": 0x100, "idMask": 0x700}},
        {"name": "status_word", "match": {"offset": -2, "value": 0xA0, "mask": 0xF0}},
    ],
    "encoders": [
        {
            "name": "telemetry",
            "template": {"cmd": 0x42, "id": 0x123},
            "fields": [],
        }
    ],
}


def rich() -> Icd:
    fields = [f for f in RICH["messages"][0]["fields"] if "expr" not in f]
    document = RICH | {"encoders": [RICH["encoders"][0] | {"fields": fields}]}
    return parse_icd(document)


VALUES: dict[str, Any] = {
    "mode": "run",
    "alarm": 1,
    "rpm": 1500.5,
    "pos": -99.5,
    "gain": 1.5,
    "ratio": 0.1,
    "tag": "BE EF",
    "label": "OK",
}


def test_rich_roundtrip_all_field_types() -> None:
    icd = rich()
    encoded = encode(icd, "telemetry", VALUES)
    assert encoded.id == 0x123 and len(encoded.frame) == 26 and encoded.wire == encoded.frame
    assert encoded.frame[1] == 0x81 and encoded.frame[2:4] == (3001).to_bytes(2, "big")
    assert encoded.frame[4:8] == (500).to_bytes(4, "little", signed=True)
    decoded = decode_frame(icd, encoded.frame, 0x123)
    assert decoded.ok and decoded.message == "telemetry"
    assert decoded.fields == {**VALUES, "tag": "beef", "rpm2": 3001.0}
    assert decoded.raw_values["mode"] == 1 and decoded.raw_values["rpm"] == 3001
    assert decode_frame(icd, encoded.frame).error == "unmatched"  # id condition needs an id
    assert decode_frame(icd, encoded.frame, 0x1AB).message == "other"
    defaults = encode(icd, "telemetry", {k: v for k, v in VALUES.items() if k != "ratio"})
    assert decode_frame(icd, defaults.frame, 0x123).fields["ratio"] == 0.25
    numeric_enum = encode(icd, "telemetry", VALUES | {"mode": 5, "alarm": 0})
    fields = decode_frame(icd, numeric_enum.frame, 0x123).fields
    assert (fields["mode"], fields["alarm"], fields["rpm2"]) == ("fault", 0, -1)
    unknown_label = encode(icd, "telemetry", VALUES | {"mode": 3})
    assert decode_frame(icd, unknown_label.frame, 0x123).fields["mode"] == 3


def test_negative_offsets_and_masks() -> None:
    icd = rich()
    frame = bytes([0x00, 0x00, 0xA7, 0x00])
    frame = frame[:-1] + bytes([frame[0] ^ frame[1] ^ frame[2]])
    assert decode_frame(icd, frame).message == "status_word"


@pytest.mark.parametrize(
    ("override", "needle"),
    [
        ({"mode": "broken"}, "not one of"),
        ({"alarm": 2}, "does not fit bits"),
        ({"rpm": -1}, "out of u16 range"),
        ({"label": "TOOLONG"}, "ASCII"),
        ({"label": "中"}, "ASCII"),
        ({"tag": "BE"}, "exactly 2 bytes"),
        ({"tag": "zz"}, "invalid hex"),
        ({"gain": "x"}, "finite number"),
    ],
)
def test_rich_encode_errors(override: dict[str, Any], needle: str) -> None:
    with pytest.raises(AppError, match=needle):
        encode(rich(), "telemetry", VALUES | override)


def framed(framing: dict[str, Any], fields: list[dict[str, Any]], **extra: Any) -> Icd:
    return parse_icd(
        {
            "formatVersion": 1,
            "name": "x",
            "transport": "bytes",
            "framing": framing,
            "messages": [{"name": "m", "match": {"offset": 0, "value": 0x7E}, "fields": fields}],
            "encoders": [{"name": "e", "fields": fields}],
        }
        | extra
    )


@pytest.mark.parametrize("covers", ["payload", "from_header", "whole"])
def test_header_length_encode_roundtrip(covers: str) -> None:
    icd = framed(
        {
            "kind": "header_length",
            "header": "7E",
            "lengthField": {"offset": 1, "size": 2, "endian": "little", "adjust": 1},
            "lengthCovers": covers,
            "trailer": "checksum",
            "footer": "7F",
        },
        [{"name": "value", "offset": 4, "type": "u16"}],
        checksum={"algorithm": "crc8", "range": {"from": 1}},
    )
    encoded = encode(icd, "e", {"value": 0x1234})
    assert len(encoded.frame) == 8 and encoded.frame.endswith(b"\x7f")
    assert icd.framing is not None
    framer = make_framer(icd.framing, icd.trailer_size())
    events = framer.feed(b"\x00" + encoded.wire + encoded.wire)
    assert [e.kind for e in events] == ["unframed", "frame", "frame"]
    decoded = decode_frame(icd, events[1].data)
    assert decoded.ok and decoded.fields == {"value": 0x1234}


def test_delimited_and_fixed_encoders() -> None:
    fields = [{"name": "v", "offset": 1, "type": "u8"}]
    line = framed({"kind": "delimiter", "delimiter": "0A", "maxLength": 3}, fields)
    assert encode(line, "e", {"v": 0x41}).frame == b"\x00\x41\x0a"
    with pytest.raises(AppError, match="contains the delimiter"):
        encode(line, "e", {"v": 0x0A})
    small = framed({"kind": "delimiter", "delimiter": "0A", "maxLength": 2}, fields)
    with pytest.raises(AppError, match="maxLength"):
        encode(small, "e", {"v": 1})

    fixed = framed({"kind": "fixed", "length": 4, "header": "7E"}, fields)
    assert encode(fixed, "e", {"v": 9}).frame == b"\x7e\x09\x00\x00"
    too_far = framed({"kind": "fixed", "length": 4}, [{"name": "v", "offset": 4, "type": "u8"}])
    with pytest.raises(AppError, match="fixed frame length"):
        encode(too_far, "e", {"v": 1})

    slip = framed({"kind": "slip"}, fields)
    encoded = encode(slip, "e", {"v": 0xC0})
    assert encoded.frame == b"\x00\xc0" and encoded.wire == slip_encode(encoded.frame)
    cobs = framed({"kind": "cobs"}, fields)
    encoded = encode(cobs, "e", {"v": 0})
    assert encoded.wire == cobs_encode(b"\x00\x00")


def test_decode_field_bounds() -> None:
    field = rich().message("telemetry").fields[2]
    with pytest.raises(ValueError, match="needs bytes 2..3"):
        decode_field(field, b"\x42\x00\x01")
