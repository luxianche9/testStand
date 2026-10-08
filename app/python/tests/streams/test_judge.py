from __future__ import annotations

from typing import Any

import pytest

from teststand_backend.streams import judge
from teststand_backend.streams.data import StreamData
from teststand_backend.streams.judge import Anchor, Window


def scalar(values: list[float], *, start: float = 0.0, step: float = 10.0) -> list[dict[str, Any]]:
    return [{"seq": i, "t": start + i * step, "v": v} for i, v in enumerate(values)]


def data(kind: str, records: list[dict[str, Any]], **extra: Any) -> StreamData:
    watermark = extra.pop("watermark", max((r["t"] for r in records), default=0.0) + 1000)
    return StreamData(kind, records, watermark=watermark, clock={"offsetMs": 0.0}, **extra)


def test_observe_scalar_statistics_pass_and_fail() -> None:
    stream = data("scalar", scalar([1.0, 1.1, 0.9, 1.0, 1.05, 0.95]))
    verdict = judge.observe(
        stream,
        Window(0, 50),
        [
            {"metric": "mean", "op": "within", "value": 1.0, "tolerance": "5%"},
            {"metric": "p2p", "op": "lt", "value": 0.3},
        ],
    )
    assert verdict["verdict"] == "pass"
    assert verdict["samples"] == 6 and verdict["resolutionMs"] == 10
    assert all(item["passed"] for item in verdict["assertions"])

    failing = judge.observe(stream, Window(0, 50), [{"metric": "max", "op": "le", "value": 1.0}])
    assert failing["verdict"] == "fail"
    assert failing["assertions"][0]["actual"] == pytest.approx(1.1)


def test_observe_inconclusive_reasons() -> None:
    records = scalar([1, 2, 3, 4, 5, 6])
    few = judge.observe(
        data("scalar", records), Window(0, 15), [{"metric": "mean", "op": "gt", "value": 0}]
    )
    assert (few["verdict"], few["reason"]) == ("inconclusive", "insufficient_evidence")

    late = judge.observe(
        data("scalar", records, watermark=30),
        Window(0, 50),
        [{"metric": "mean", "op": "gt", "value": 0}],
    )
    assert late["reason"] == "watermark_timeout"

    gapped = judge.observe(
        data("scalar", records, gaps=[{"reason": "overflow", "t0": 20, "t1": 25}]),
        Window(0, 50),
        [{"metric": "mean", "op": "gt", "value": 0}],
    )
    assert gapped["reason"] == "gap" and gapped["gaps"]

    short = judge.observe(
        data("scalar", scalar([1, 1, 1], step=1) + scalar([1], start=100)),
        Window(0, 2),
        [{"metric": "mean", "op": "gt", "value": 0}],
        min_samples=1,
    )
    assert short["verdict"] == "pass"  # median interval 1 ms, window 2 ms


def test_observe_block_expands_samples() -> None:
    blocks = [
        {"seq": 0, "t": 0.0, "t0": 0.0, "dt": 1.0, "samples": [0.0, 1.0, 2.0, 3.0]},
        {"seq": 1, "t": 4.0, "t0": 4.0, "dt": 1.0, "samples": [4.0, 5.0, 6.0, 7.0]},
    ]
    verdict = judge.observe(
        data("block", blocks),
        Window(2, 6),
        [
            {"metric": "min", "op": "eq", "value": 2},
            {"metric": "max", "op": "eq", "value": 6},
            {"metric": "count", "op": "eq", "value": 5},
        ],
    )
    assert verdict["verdict"] == "pass", verdict


def test_observe_bits_uses_held_state() -> None:
    records = [{"seq": 0, "t": 0.0, "mask": 0b01}, {"seq": 1, "t": 50.0, "mask": 0b11}]
    stream = data("bits", records)
    high = judge.observe(
        stream,
        Window(10, 40),
        [
            {"metric": "bit0.high", "op": "eq", "value": True},
            {"metric": "bit1.low", "op": "eq", "value": True},
        ],
    )
    assert high["verdict"] == "pass", high
    edges = judge.observe(
        stream, Window(10, 60), [{"metric": "bit1.edges", "op": "eq", "value": 1}]
    )
    assert edges["verdict"] == "pass"
    unknown = judge.observe(
        data("bits", records[1:]),
        Window(10, 40),
        [{"metric": "bit0.high", "op": "eq", "value": True}],
    )
    assert unknown["reason"] == "insufficient_evidence"


def test_observe_bytes_and_frames_metrics() -> None:
    serial = [
        {"seq": 0, "t": 1.0, "dir": "tx", "data": b"*IDN?\n".hex()},
        {"seq": 1, "t": 5.0, "dir": "rx", "data": b"ACME,".hex()},
        {"seq": 2, "t": 6.0, "dir": "rx", "data": b"X1\r\n".hex()},
    ]
    verdict = judge.observe(
        data("bytes", serial),
        Window(0, 10),
        [
            {"metric": "rx.text", "op": "matches", "value": r"^ACME,X\d"},
            {"metric": "tx.text", "op": "contains", "value": "IDN"},
            {"metric": "rx.bytes", "op": "eq", "value": 9},
        ],
    )
    assert verdict["verdict"] == "pass", verdict

    frames = [
        {"seq": 0, "t": 1.0, "dir": "rx", "id": "0x123", "data": "0102"},
        {"seq": 1, "t": 2.0, "dir": "rx", "id": "0x124", "data": "ff"},
        {"seq": 2, "t": 3.0, "dir": "rx", "id": 0x123, "data": "0103"},
    ]
    verdict = judge.observe(
        data("frames", frames),
        Window(0, 10),
        [
            {"metric": "id.0x123.count", "op": "eq", "value": 2},
            {"metric": "id.0x123.last", "op": "eq", "value": "0103"},
            {"metric": "rx.count", "op": "ge", "value": 3},
        ],
    )
    assert verdict["verdict"] == "pass", verdict


def test_expect_scalar_latency_and_deadline() -> None:
    stream = data("scalar", scalar([0, 0, 0, 5, 5]))
    hit = judge.expect(stream, Window(5, 100), {"op": "gt", "value": 4})
    assert hit["verdict"] == "pass" and hit["matchT"] == 30 and hit["latencyMs"] == 25
    miss = judge.expect(stream, Window(0, 20), {"op": "gt", "value": 4})
    assert miss["verdict"] == "fail"
    pending = judge.expect(
        data("scalar", scalar([0, 0]), watermark=15), Window(0, 20), {"op": "gt", "value": 4}
    )
    assert pending["reason"] == "watermark_timeout"


def test_expect_bits_edge_versus_level() -> None:
    records = [
        {"seq": 0, "t": 0.0, "mask": 1},
        {"seq": 1, "t": 20.0, "mask": 0},
        {"seq": 2, "t": 30.0, "mask": 1},
    ]
    stream = data("bits", records)
    edge = judge.expect(stream, Window(10, 50), {"bit": 0, "level": True})
    assert edge["matchT"] == 30
    level = judge.expect(stream, Window(10, 50), {"bit": 0, "level": True, "edge": False})
    assert level["matchT"] == 10 and level["latencyMs"] == 0


def test_expect_bytes_across_records() -> None:
    serial = [
        {"seq": 0, "t": 1.0, "dir": "rx", "data": b"OK".hex()},
        {"seq": 1, "t": 2.0, "dir": "rx", "data": b"\r\nREADY".hex()},
    ]
    stream = data("bytes", serial)
    assert judge.expect(stream, Window(0, 10), {"pattern": "OK\\r\\nREA"})["matchT"] == 2
    assert judge.expect(stream, Window(0, 10), {"hex": b"READY".hex()})["verdict"] == "pass"
    assert judge.expect(stream, Window(0, 10), {"dir": "tx", "pattern": "OK"})["verdict"] == "fail"


def test_guard_holds_or_reports_first_violation() -> None:
    stream = data("scalar", scalar([1, 1, 9, 1]))
    ok = judge.guard(stream, Window(0, 15), {"op": "lt", "value": 5})
    assert ok["verdict"] == "pass"
    bad = judge.guard(stream, Window(0, 40), {"op": "lt", "value": 5})
    assert bad["verdict"] == "fail" and bad["violation"]["t"] == 20

    frames = data("frames", [{"seq": 0, "t": 10.0, "dir": "rx", "id": 0x7FF, "data": "00"}])
    assert judge.guard(frames, Window(0, 5), {"id": "0x7ff"})["verdict"] == "pass"
    assert judge.guard(frames, Window(0, 20), {"id": "0x7ff"})["verdict"] == "fail"

    bits = data("bits", [{"seq": 0, "t": 0.0, "mask": 0}, {"seq": 1, "t": 8.0, "mask": 4}])
    assert judge.guard(bits, Window(1, 5), {"bit": 2, "level": False})["verdict"] == "pass"
    assert judge.guard(bits, Window(1, 9), {"bit": 2, "level": False})["verdict"] == "fail"


def test_map_window_same_and_cross_service() -> None:
    anchor = Anchor(1000.0, "psu", {"offsetMs": 100.0, "uncertaintyMs": 1.0})
    same = judge.map_window(anchor, "psu", {"offsetMs": 7.0}, 0, 50)
    assert (same.t0, same.t1, same.uncertainty_ms) == (1000, 1050, 0)

    other = judge.map_window(anchor, "daq", {"offsetMs": 40.0, "uncertaintyMs": 2.0}, 0, 50)
    assert (other.t0, other.t1, other.uncertainty_ms) == (943, 987, 3)
    assert not other.warnings
    noisy = judge.map_window(anchor, "daq", {"offsetMs": 40.0, "uncertaintyMs": 9.0}, 0, 50)
    assert noisy.warnings

    deadline = judge.map_window(
        anchor, "daq", {"offsetMs": 40.0, "uncertaintyMs": 2.0}, 0, 50, shrink=False
    )
    assert (deadline.t0, deadline.t1) == (940, 990)


def test_check_result_paths_and_tolerance() -> None:
    call = {"result": {"value": 3.28, "channels": [{"v": 1}]}, "timing": {"serverEnd": 5}}
    verdict = judge.check_result(
        call,
        [
            {"metric": "result.value", "op": "eq", "value": 3.3, "tolerance": 0.05},
            {"metric": "result.channels.0.v", "op": "ge", "value": 1},
            {"metric": "result.value", "op": "within", "value": [3.2, 3.4]},
        ],
    )
    assert verdict["verdict"] == "pass", verdict
    missing = judge.check_result(call, [{"metric": "result.nope", "op": "eq", "value": 1}])
    assert missing["reason"] == "insufficient_evidence"


def test_validation_messages() -> None:
    assert judge.metric_error("scalar", "mean") is None
    assert judge.metric_error("bits", "bit3.edges") is None
    assert judge.metric_error("bits", "mean")
    assert judge.metric_error("frames", "id.0x10.count") is None
    assert judge.assertion_error({"metric": "mean", "op": "within", "value": 1}) is not None
    assert (
        judge.assertion_error({"metric": "mean", "op": "within", "value": 1, "tolerance": "2%"})
        is None
    )
    assert judge.assertion_error({"metric": "rx.text", "op": "matches", "value": "("})
    assert judge.match_error("bytes", {"pattern": "x", "hex": "00"})
    assert judge.match_error("bits", {"bit": 1, "level": True}) is None
    assert judge.match_error("scalar", {"op": "within", "value": 1})


def test_cross_correlation_peak_next_to_an_unscored_edge_lag_stays_finite() -> None:
    # Four samples: lag +-2 leaves two pairs (unscored, -inf) next to the true peak at +1.
    reference = [(0.0, 1.0), (10.0, 3.0), (20.0, 2.0), (30.0, 5.0)]
    signal = [(0.0, 4.0), (10.0, 1.0), (20.0, 3.0), (30.0, 2.0)]
    delay, peak = judge.cross_correlation_delay(signal, reference, 100.0)
    assert delay == pytest.approx(10.0) and peak == pytest.approx(1.0)
