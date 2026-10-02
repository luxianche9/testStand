from __future__ import annotations

import random
from typing import Any

import pytest
from pydantic import TypeAdapter

from hardwareharness_backend.protocol.framing import (
    CobsFramer,
    DelimiterFramer,
    FixedFramer,
    Framer,
    FramerEvent,
    HeaderLengthFramer,
    SlipFramer,
    cobs_decode,
    cobs_encode,
    make_framer,
    slip_decode,
    slip_encode,
)
from hardwareharness_backend.protocol.icd import Framing

from .icd_fixtures import ack_frame, dut_cmd, status_frame

FRAMING: TypeAdapter[Framing] = TypeAdapter(Framing)


def framer(spec: dict[str, Any], trailer_size: int = 0) -> Framer:
    return make_framer(FRAMING.validate_python(spec), trailer_size)


def dut_framer() -> Framer:
    icd = dut_cmd()
    assert icd.framing is not None
    return make_framer(icd.framing, icd.trailer_size())


def run(target: Framer, chunks: list[bytes]) -> list[FramerEvent]:
    return [event for chunk in chunks for event in target.feed(chunk)]


def kinds(events: list[FramerEvent]) -> list[tuple[str, bytes, str | None]]:
    return [(event.kind, event.data, event.reason) for event in events]


def summary(events: list[FramerEvent]) -> tuple[list[tuple[str, bytes]], bytes]:
    """Frames/errors in order plus all unframed bytes (unframed runs are split per chunk)."""
    framed: list[tuple[str, bytes]] = [(e.kind, e.data) for e in events if e.kind != "unframed"]
    return framed, b"".join(e.data for e in events if e.kind == "unframed")


def assert_split_independent(make: Any, stream: bytes) -> list[FramerEvent]:
    whole = run(make(), [stream])
    single = run(make(), [bytes([b]) for b in stream])
    rng = random.Random(len(stream))
    cuts = sorted(rng.sample(range(1, len(stream)), min(5, len(stream) - 1)))
    pieces = [stream[a:b] for a, b in zip([0, *cuts], [*cuts, len(stream)], strict=True)]
    assert summary(single) == summary(whole) == summary(run(make(), pieces))
    covered = sorted((e.start, e.end) for e in whole)
    for (_, end), (start, _) in zip(covered, covered[1:], strict=False):
        assert end <= start
    return whole


def test_header_length_frames_and_resyncs() -> None:
    status, ack = status_frame(), ack_frame(7)
    stream = b"\x00\xff" + status + b"\xaa" + ack + b"\x13\xaa"
    target = dut_framer()
    events = target.feed(stream)
    assert kinds(events) == [
        ("unframed", b"\x00\xff", "no_header"),
        ("frame", status, None),
        ("unframed", b"\xaa", "no_header"),
        ("frame", ack, None),
        ("unframed", b"\x13", "no_header"),
    ]
    assert events[1].start == 2 and events[1].end == 2 + len(status)
    assert target.pending == 1  # a trailing 0xAA could still start a header
    assert kinds(target.reset("gap")) == [("unframed", b"\xaa", "gap")]
    assert target.pending == 0 and target.reset("gap") == []
    assert_split_independent(dut_framer, stream)


def test_header_length_rejects_bad_lengths() -> None:
    def make() -> Framer:
        return framer(
            {
                "kind": "header_length",
                "header": "AA 55",
                "lengthField": {"offset": 2, "size": 1},
                "maxLength": 16,
            }
        )

    good = b"\xaa\x55\x02\x01\x02"
    events = assert_split_independent(make, b"\xaa\x55\xf0" + good)
    assert kinds(events) == [("unframed", b"\xaa\x55\xf0", "bad_length"), ("frame", good, None)]


@pytest.mark.parametrize(
    ("covers", "adjust", "value"),
    [("payload", 0, 2), ("from_header", 0, 4), ("whole", 0, 5), ("whole", 1, 4)],
)
def test_header_length_coverage_modes(covers: str, adjust: int, value: int) -> None:
    target = framer(
        {
            "kind": "header_length",
            "header": "7E",
            "lengthField": {"offset": 1, "size": 2, "endian": "little", "adjust": adjust},
            "lengthCovers": covers,
        }
    )
    frame = b"\x7e" + value.to_bytes(2, "little") + b"\x01\x02"
    assert kinds(target.feed(frame + frame)) == [("frame", frame, None)] * 2


def test_delimiter_framer() -> None:
    def make() -> Framer:
        return framer({"kind": "delimiter", "delimiter": "0D 0A", "maxLength": 8})

    stream = b"\r\nabc\r\n0123456789\r\nabcdef\r\n"
    events = assert_split_independent(make, stream)
    assert kinds(events) == [
        ("unframed", b"\r\n", "empty"),
        ("frame", b"abc\r\n", None),
        ("unframed", b"0123456789\r\n", "too_long"),
        ("frame", b"abcdef\r\n", None),
    ]
    target = make()
    assert kinds(target.feed(b"0123456789\r")) == [("unframed", b"0123456789", "too_long")]
    assert target.pending == 1
    assert kinds(target.feed(b"\nx\r\n")) == [
        ("unframed", b"\r\n", "too_long"),
        ("frame", b"x\r\n", None),
    ]
    assert kinds(target.feed(b"012345678")) == [("unframed", b"012345678", "too_long")]
    assert kinds(target.reset("gap")) == []
    assert kinds(target.feed(b"ab\r\n")) == [("frame", b"ab\r\n", None)]


def test_fixed_framer() -> None:
    def make() -> Framer:
        return framer({"kind": "fixed", "length": 4, "header": "A5"})

    stream = b"\x00\xa5\x01\x02\x03\xa5\xa5\x04\x05\x06"
    events = assert_split_independent(make, stream)
    assert kinds(events) == [
        ("unframed", b"\x00", "no_header"),
        ("frame", b"\xa5\x01\x02\x03", None),
        ("frame", b"\xa5\xa5\x04\x05", None),
        ("unframed", b"\x06", "no_header"),
    ]
    headerless = framer({"kind": "fixed", "length": 2})
    assert isinstance(headerless, FixedFramer)
    assert kinds(headerless.feed(b"\x01\x02\x03")) == [("frame", b"\x01\x02", None)]
    assert headerless.pending == 1


def test_slip_framer() -> None:
    payloads = [b"\xc0\xdb\x01", b"", b"plain"]
    stream = b"".join(slip_encode(p) for p in payloads) + b"\xdb\x01\xc0" + slip_encode(b"z")

    def make() -> Framer:
        return framer({"kind": "slip", "maxLength": 4})

    events = assert_split_independent(make, stream)
    assert kinds(events) == [
        ("frame", b"\xc0\xdb\x01", None),
        ("error", b"plain\xc0", "too_long"),
        ("error", b"\xdb\x01\xc0", "bad_escape"),
        ("frame", b"z", None),
    ]
    assert events[0].end - events[0].start == len(slip_encode(payloads[0])) - 1
    target = make()
    assert isinstance(target, SlipFramer)
    assert kinds(target.feed(b"x" * 11)) == [("unframed", b"x" * 11, "too_long")]
    assert kinds(target.feed(b"y\xc0\x01\xc0")) == [
        ("unframed", b"y\xc0", "too_long"),
        ("frame", b"\x01", None),
    ]
    assert_split_independent(make, b"x" * 30 + b"\xc0\x01\xc0")


def test_cobs_framer() -> None:
    def make() -> Framer:
        return framer({"kind": "cobs", "maxLength": 300})

    payloads = [b"\x00", b"\x11\x00\x22", bytes(range(1, 256)) * 1]
    stream = b"".join(cobs_encode(p) for p in payloads) + b"\x05\x01\x00" + cobs_encode(b"k")
    events = assert_split_independent(make, stream)
    assert [e.data for e in events if e.kind == "frame"] == [*payloads, b"k"]
    assert kinds(events)[3] == ("error", b"\x05\x01\x00", "bad_cobs")
    assert isinstance(make(), CobsFramer)


def test_slip_and_cobs_roundtrip() -> None:
    rng = random.Random(8)
    samples = [b"", b"\x00" * 3, b"\xff" * 254, b"\x01" * 254, b"\x01" * 600]
    samples += [bytes(rng.randrange(256) for _ in range(rng.randrange(0, 700))) for _ in range(40)]
    for data in samples:
        encoded = cobs_encode(data)
        assert encoded.count(0) == 1 and encoded.endswith(b"\x00")
        assert cobs_decode(encoded[:-1]) == data
        wire = slip_encode(data)
        assert wire[0] == wire[-1] == 0xC0 and 0xC0 not in wire[1:-1]
        assert slip_decode(wire[1:-1]) == data
    for bad in (b"\x03\x01", b"\x02\x00"):
        with pytest.raises(ValueError, match="bad_cobs"):
            cobs_decode(bad)
    for bad in (b"\xdb", b"\xdb\x00"):
        with pytest.raises(ValueError, match="bad_escape"):
            slip_decode(bad)


def test_make_framer_types() -> None:
    assert isinstance(dut_framer(), HeaderLengthFramer)
    assert isinstance(framer({"kind": "delimiter", "delimiter": "0A"}), DelimiterFramer)
