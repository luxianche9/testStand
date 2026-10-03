from __future__ import annotations

from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.protocol import (
    DerivedRecord,
    ProtocolDecoder,
    decode_records,
    derived_streams,
    parse_icd,
)
from teststand_backend.protocol.framing import slip_encode

from .icd_fixtures import ack_frame, dut_cmd, status_frame

STATUS, ACK = status_frame(), ack_frame(9)


def raw(seq: int, data: bytes, t: float | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "t": float(seq) if t is None else t,
        "seq": seq,
        "dir": "rx",
        "data": data.hex(),
    } | extra


def by_stream(items: list[DerivedRecord]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        grouped.setdefault(item.stream_id, []).append(item.record)
    return grouped


def test_derived_stream_catalogue() -> None:
    streams = {s.stream_id: s for s in derived_streams(dut_cmd(), "dut")}
    assert list(streams) == [
        "dut.status",
        "dut.status.selfTest",
        "dut.status.voltage",
        "dut.status.temp",
        "dut.status.selfTestRaw",
        "dut.status.power",
        "dut.ack",
        "dut.ack.code",
        "dut.mode_echo",
        "dut.mode_echo.mode",
        "dut.$errors",
        "dut.$unframed",
    ]
    assert streams["dut.status"].stream_type == "frames"
    assert streams["dut.status.voltage"].stream_type == "scalar"
    assert (streams["dut.status.voltage"].unit, streams["dut.status.power"].unit) == ("V", "W")
    assert streams["dut.$unframed"].stream_type == "bytes"
    for alias in ("", "1dut", "a.b", "a-b"):
        with pytest.raises(AppError) as caught:
            derived_streams(dut_cmd(), alias)
        assert caught.value.category == "invalid_argument"


def test_frames_split_across_records() -> None:
    decoder = ProtocolDecoder(dut_cmd(), "dut")
    first = decoder.feed(raw(0, b"\x00\xff" + STATUS[:6], tb=1000, op="op-1"))
    assert by_stream(first) == {
        "dut.$unframed": [
            {
                "t": 0.0,
                "tb": 1000,
                "op": "op-1",
                "seq": 0,
                "dir": "rx",
                "data": "00ff",
                "reason": "no_header",
            }
        ]
    }
    streams = by_stream(decoder.feed(raw(1, STATUS[6:] + ACK)))
    assert streams["dut.status"] == [
        {
            "t": 1.0,
            "seq": 1,
            "seqFrom": 0,
            "dir": "rx",
            "message": "status",
            "fields": {
                "selfTest": "pass",
                "voltage": pytest.approx(12.34),
                "temp": pytest.approx(-5.2),
                "version": "V1.2.3",
                "selfTestRaw": 1,
                "power": pytest.approx(25.68),
            },
            "raw": STATUS.hex(),
            "checksumOk": True,
        }
    ]
    assert streams["dut.status.selfTest"] == [{"t": 1.0, "seq": 1, "v": 1}]
    assert streams["dut.status.voltage"] == [{"t": 1.0, "seq": 1, "v": pytest.approx(12.34)}]
    assert "dut.status.version" not in streams
    assert streams["dut.ack"][0]["fields"] == {"code": 9} and "seqFrom" not in streams["dut.ack"][0]
    assert streams["dut.ack.code"] == [{"t": 1.0, "seq": 1, "v": 9}]


def test_directions_have_separate_buffers_and_marks_are_ignored() -> None:
    decoder = ProtocolDecoder(dut_cmd(), "dut")
    assert decoder.feed(raw(0, STATUS[:4])) == []
    assert decoder.feed({"t": 0.5, "seq": 1, "dir": "mark", "text": "step 1"}) == []
    tx = by_stream(decoder.feed(raw(2, ACK, dir="tx")))
    assert tx["dut.ack"][0]["dir"] == "tx"
    rx = by_stream(decoder.feed(raw(3, STATUS[4:])))
    assert rx["dut.status"][0]["seqFrom"] == 0 and rx["dut.status"][0]["dir"] == "rx"


def test_errors_stream() -> None:
    decoder = ProtocolDecoder(dut_cmd(), "dut")
    corrupted = bytearray(STATUS)
    corrupted[-1] ^= 1
    streams = by_stream(decoder.feed(raw(0, bytes(corrupted))))
    [error] = streams["dut.$errors"]
    assert error["reason"] == "checksum" and error["checksumOk"] is False
    assert error["message"] == "status" and error["fields"]["selfTest"] == "pass"
    assert list(streams) == ["dut.$errors"]
    [bad_hex] = by_stream(decoder.feed({"t": 1.0, "seq": 1, "dir": "rx", "data": "zz"}))[
        "dut.$errors"
    ]
    assert (bad_hex["reason"], bad_hex["raw"], bad_hex["detail"]) == ("bad_hex", "", "zz")


def test_framing_errors_reach_errors_stream() -> None:
    icd = parse_icd(
        {
            "formatVersion": 1,
            "name": "slip",
            "transport": "bytes",
            "framing": {"kind": "slip"},
            "messages": [
                {
                    "name": "m",
                    "match": {"length": 1},
                    "fields": [{"name": "v", "offset": 0, "type": "u8"}],
                }
            ],
        }
    )
    decoder = ProtocolDecoder(icd, "s")
    streams = by_stream(decoder.feed(raw(0, b"\xdb\x01\xc0" + slip_encode(b"\x05"))))
    assert streams["s.$errors"] == [
        {
            "t": 0.0,
            "seq": 0,
            "dir": "rx",
            "reason": "framing",
            "raw": "db01c0",
            "checksumOk": None,
            "detail": "bad_escape",
        }
    ]
    assert streams["s.m.v"] == [{"t": 0.0, "seq": 0, "v": 5}]
    assert "s.$unframed" not in streams


def test_frames_transport_decodes_each_record() -> None:
    icd = parse_icd(
        {
            "formatVersion": 1,
            "name": "can_like",
            "transport": "frames",
            "messages": [
                {
                    "name": "speed",
                    "match": {"id": 0x80000123},
                    "fields": [{"name": "kmh", "offset": 0, "type": "u16"}],
                }
            ],
        }
    )
    assert "c.$unframed" not in {s.stream_id for s in derived_streams(icd, "c")}
    decoder = ProtocolDecoder(icd, "c")
    record = raw(4, b"\x00\x2a", id=0x80000123)
    streams = by_stream(decoder.feed(record))
    assert streams["c.speed"][0]["id"] == 0x80000123
    assert streams["c.speed.kmh"] == [{"t": 4.0, "seq": 4, "v": 42}]
    [error] = by_stream(decoder.feed(raw(5, b"\x00", id=0x7FF)))["c.$errors"]
    assert (error["reason"], error["id"]) == ("unmatched", 0x7FF)
    assert decoder.gap() == []


def test_gap_resets_buffers() -> None:
    decoder = ProtocolDecoder(dut_cmd(), "dut")
    assert decoder.feed(raw(0, STATUS[:10])) == []
    [dropped] = decoder.gap("overflow")
    assert dropped.stream_id == "dut.$unframed"
    assert dropped.record["data"] == STATUS[:10].hex() and dropped.record["reason"] == "overflow"
    streams = by_stream(decoder.feed(raw(1, STATUS[10:] + STATUS)))
    assert streams["dut.$unframed"][0]["data"] == STATUS[10:].hex()
    assert streams["dut.status"][0]["seq"] == 1 and "seqFrom" not in streams["dut.status"][0]
    assert decoder.flush() == []


def test_on_event_maps_hub_events() -> None:
    decoder = ProtocolDecoder(dut_cmd(), "dut")
    batch = {"type": "batch", "records": [raw(0, STATUS + ACK[:3])], "watermark": 1.5}
    [out] = decoder.on_event(batch)
    assert out["type"] == "batch" and out["watermark"] == 1.5
    assert set(out["streams"]) >= {"dut.status", "dut.status.voltage"}
    gap = {"type": "gap", "t0": 1.5, "t1": 2.0, "reason": "dropped"}
    remainder, passed = decoder.on_event(gap)
    assert remainder == {
        "type": "batch",
        "streams": {
            "dut.$unframed": [
                {"t": 0.0, "seq": 0, "dir": "rx", "data": ACK[:3].hex(), "reason": "dropped"}
            ]
        },
        "watermark": None,
    }
    assert passed == gap and passed is not gap
    assert decoder.on_event(gap) == [gap]
    assert decoder.on_event({"type": "state", "state": "running"}) == [
        {"type": "state", "state": "running"}
    ]
    assert decoder.on_event({"type": "batch", "watermark": 3.0}) == [
        {"type": "batch", "streams": {}, "watermark": 3.0}
    ]


def test_decode_records_matches_online_decoding() -> None:
    records = [
        raw(0, STATUS[:5]),
        raw(1, STATUS[5:] + ACK[:4]),
        raw(2, ACK[4:]),
        raw(3, STATUS[:7], t=5.0),
        raw(4, STATUS[7:], t=6.0),
    ]
    gaps = [{"t0": 4.0, "t1": 4.5}]
    online = ProtocolDecoder(dut_cmd(), "dut")
    expected: dict[str, list[dict[str, Any]]] = {}
    for record in records[:3]:
        for item in online.feed(record):
            expected.setdefault(item.stream_id, []).append(item.record)
    for item in [*online.gap(), *online.feed(records[3]), *online.feed(records[4])]:
        expected.setdefault(item.stream_id, []).append(item.record)

    offline = decode_records(dut_cmd(), "dut", records, gaps=gaps)
    assert offline == expected
    assert decode_records(dut_cmd(), "dut", records, gaps=gaps) == offline  # deterministic
    assert [r["seq"] for r in offline["dut.status"]] == [1, 4]
    assert offline["dut.ack"][0]["seqFrom"] == 1

    with_gap = decode_records(dut_cmd(), "dut", records, gaps=[{"t0": 0.5, "t1": 0.6}])
    assert with_gap["dut.$unframed"][0]["data"] == STATUS[:5].hex()
    assert [r["seq"] for r in with_gap["dut.status"]] == [4]

    tail = decode_records(dut_cmd(), "dut", records[:4], flush=True)
    assert tail["dut.$unframed"] == [
        {"t": 5.0, "seq": 3, "dir": "rx", "data": STATUS[:7].hex(), "reason": "incomplete"}
    ]
