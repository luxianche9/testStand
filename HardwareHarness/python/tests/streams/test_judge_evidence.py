"""§7.4 waveform/cross-stream metrics, §7.5 Expect captures and §7.7 evidence grades."""

from __future__ import annotations

import math
from typing import Any

import pytest

from hardwareharness_backend.streams import judge
from hardwareharness_backend.streams.data import StreamData
from hardwareharness_backend.streams.judge import Window

Records = list[dict[str, Any]]


def sampled(fn: Any, *, stop: float, step: float = 1.0, start: float = 0.0) -> Records:
    count = int(round((stop - start) / step)) + 1
    return [
        {"seq": i, "t": start + i * step, "v": float(fn(start + i * step))} for i in range(count)
    ]


def data(kind: str, records: Records, **extra: Any) -> StreamData:
    watermark = extra.pop("watermark", max((r["t"] for r in records), default=0.0) + 1000)
    clock = extra.pop("clock", {"offsetMs": 0.0})
    return StreamData(kind, records, watermark=watermark, clock=clock, **extra)


def square(t: float) -> float:
    return 1.0 if t % 20 < 5 else 0.0  # 50 Hz, 25 % duty


def ramp(t: float) -> float:
    return min(10.0, max(0.0, t - 50.0))  # 0 -> 10 between t=50 and t=60


# -- §7.4 waveform metrics -----------------------------------------------------------------


def test_rms_and_pp_are_scalar_metrics() -> None:
    stream = data("scalar", sampled(lambda t: 1.0 if int(t) % 2 else -1.0, stop=99))
    verdict = judge.observe(
        stream,
        Window(0, 99),
        [
            {"metric": "rms", "op": "within", "value": 1.0, "tolerance": 1e-9},
            {"metric": "pp", "op": "eq", "value": 2.0},
        ],
    )
    assert verdict["verdict"] == "pass", verdict


def test_freq_period_duty_of_a_square_wave() -> None:
    stream = data("scalar", sampled(square, stop=199))
    verdict = judge.observe(
        stream,
        Window(0, 199),
        [
            {"metric": "freq", "op": "within", "value": 50, "tolerance": "1%"},
            {"metric": "period", "op": "within", "value": 20, "tolerance": 0.01},
            {"metric": "duty", "op": "within", "value": 0.25, "tolerance": 0.01},
        ],
    )
    assert verdict["verdict"] == "pass", verdict
    first = verdict["assertions"][0]
    assert first["waveform"]["threshold"] == 0.5 and first["waveform"]["edges"] > 10
    assert verdict["metrics"]["freq"] == pytest.approx(50)


def test_hysteresis_ignores_noise_around_the_threshold() -> None:
    # A 0.02 ripple at the threshold would count as edges without hysteresis.
    def noisy(t: float) -> float:
        return square(t) + (0.02 if int(t) % 2 else -0.02) + (0.5 if 8 <= t % 20 < 12 else 0)

    stream = data("scalar", sampled(noisy, stop=199))
    bare = judge.observe(
        stream,
        Window(0, 199),
        [{"metric": "freq", "op": "gt", "value": 0, "threshold": 0.5, "hysteresis": 0}],
    )
    held = judge.observe(
        stream,
        Window(0, 199),
        [{"metric": "freq", "op": "gt", "value": 0, "threshold": 0.75, "hysteresis": 0.1}],
    )
    assert held["metrics"]["freq"] == pytest.approx(50)
    assert bare["assertions"][0]["waveform"]["edges"] > held["assertions"][0]["waveform"]["edges"]


def test_freq_without_edges_is_inconclusive() -> None:
    verdict = judge.observe(
        data("scalar", sampled(lambda _t: 1.0, stop=50)),
        Window(0, 50),
        [{"metric": "freq", "op": "gt", "value": 1}],
    )
    assert (verdict["verdict"], verdict["reason"]) == ("inconclusive", "insufficient_evidence")


def test_rise_and_fall_times_use_10_to_90_percent() -> None:
    up = data("scalar", sampled(ramp, stop=100))
    rise = judge.observe(up, Window(0, 100), [{"metric": "riseMs", "op": "lt", "value": 9}])
    assert rise["verdict"] == "pass" and rise["metrics"]["riseMs"] == pytest.approx(8)
    assert any("sample interval" in warning for warning in rise["warnings"])

    down = data("scalar", sampled(lambda t: 10 - ramp(t), stop=100))
    fall = judge.observe(
        down, Window(0, 100), [{"metric": "fallMs", "op": "within", "value": [7.5, 8.5]}]
    )
    assert fall["verdict"] == "pass", fall
    # Explicit levels: 10 %..90 % of 0..20 is 2..18, which a 0..10 ramp never reaches.
    capped = judge.observe(
        up, Window(0, 100), [{"metric": "riseMs", "op": "lt", "value": 9, "low": 0, "high": 20}]
    )
    assert capped["verdict"] == "inconclusive"


def test_settle_time_into_a_band() -> None:
    stream = data("scalar", sampled(lambda t: 5 * (1 - math.exp(-t / 10)), stop=100))
    verdict = judge.observe(
        stream,
        Window(0, 100),
        [{"metric": "settleMs", "op": "lt", "value": 45, "target": 5, "band": "2%"}],
    )
    assert verdict["verdict"] == "pass", verdict
    assert verdict["metrics"]["settleMs"] == pytest.approx(39.1, abs=0.2)
    assert verdict["assertions"][0]["waveform"] == {"target": 5.0, "band": 0.1}


def test_settle_time_never_reached_is_a_lower_bound() -> None:
    stream = data("scalar", sampled(lambda t: t, stop=100))
    spec = {"metric": "settleMs", "target": 1000, "band": 1}
    too_slow = judge.observe(stream, Window(0, 100), [{**spec, "op": "lt", "value": 50}])
    assert too_slow["verdict"] == "fail", too_slow
    assert too_slow["assertions"][0]["waveform"]["notSettledAfterMs"] == 100
    slow_enough = judge.observe(stream, Window(0, 100), [{**spec, "op": "gt", "value": 20}])
    assert slow_enough["verdict"] == "pass"
    unknown = judge.observe(stream, Window(0, 100), [{**spec, "op": "gt", "value": 500}])
    assert unknown["verdict"] == "inconclusive"


def test_waveform_assertion_parameters_are_validated() -> None:
    ok = {"metric": "freq", "op": "gt", "value": 1}
    assert judge.assertion_error({**ok, "threshold": 0.5, "hysteresis": 0.1}) is None
    assert judge.assertion_error({**ok, "hysteresis": -1})
    assert judge.assertion_error({**ok, "threshold": "high"})
    assert judge.assertion_error({"metric": "settleMs", "op": "lt", "value": 5})  # band missing
    assert judge.assertion_error({"metric": "settleMs", "op": "lt", "value": 5, "band": "x"})
    assert judge.metric_error("scalar", "duty") is None
    assert judge.metric_error("block", "riseMs") is None
    assert judge.metric_error("bits", "freq")
    assert judge.compare_metric_error("delayMs") is None
    assert judge.compare_metric_error("freq")


# -- §7.4 cross-stream comparison ----------------------------------------------------------


def sine(amplitude: float, delay: float, *, shift: float = 0.0) -> Records:
    return sampled(
        lambda t: amplitude * math.sin(2 * math.pi * 50 * (t - shift - delay) / 1000),
        start=shift,
        stop=shift + 100,
        step=0.5,
    )


def test_compare_delay_phase_and_ratio_on_one_clock() -> None:
    reference = data("scalar", sine(1.0, 0.0))
    signal = data("scalar", sine(0.5, 2.0))
    verdict = judge.compare(
        signal,
        reference,
        Window(0, 100),
        Window(0, 100),
        [
            {"metric": "delayMs", "op": "within", "value": 2, "tolerance": 0.1},
            {"metric": "phaseDeg", "op": "within", "value": 36, "tolerance": 2},
            {"metric": "ratio", "op": "within", "value": 0.5, "tolerance": "1%"},
            {"metric": "correlation", "op": "gt", "value": 0.99},
        ],
        same_clock=True,
    )
    assert verdict["verdict"] == "pass", verdict
    assert verdict["clockUncertaintyMs"] == 0
    assert verdict["evidenceType"] == "T1"


def test_compare_across_devices_carries_clock_uncertainty() -> None:
    # The signal's service clock runs 10 ms ahead of backend time, uncertain by 1 ms.
    clock = {"offsetMs": 10.0, "uncertaintyMs": 1.0}
    signal = data("scalar", sine(1.0, 2.0, shift=10.0), clock=clock)
    reference = data("scalar", sine(1.0, 0.0), clock={"offsetMs": 0.0, "uncertaintyMs": 1.0})
    tight = judge.compare(
        signal,
        reference,
        Window(10, 110),
        Window(0, 100),
        [{"metric": "delayMs", "op": "within", "value": 2, "tolerance": 0.5}],
    )
    assert (tight["verdict"], tight["reason"]) == ("inconclusive", "clock_uncertainty")
    assert tight["clockUncertaintyMs"] == 2
    assert tight["assertions"][0]["actual"] == pytest.approx(2, abs=0.1)
    assert tight["assertions"][0]["uncertainty"] == 2

    loose = judge.compare(
        signal,
        reference,
        Window(10, 110),
        Window(0, 100),
        [{"metric": "delayMs", "op": "lt", "value": 10}],
    )
    assert loose["verdict"] == "pass", loose


def test_compare_needs_numeric_streams() -> None:
    serial = data("bytes", [{"seq": 0, "t": 1.0, "dir": "rx", "data": "00"}])
    reference = data("scalar", sine(1.0, 0.0))
    verdict = judge.compare(
        serial,
        reference,
        Window(0, 100),
        Window(0, 100),
        [{"metric": "ratio", "op": "gt", "value": 0}],
    )
    assert verdict["verdict"] == "inconclusive"


# -- §7.5 captures -------------------------------------------------------------------------


def test_expect_captures_from_bytes_text() -> None:
    serial = [
        {"seq": 0, "t": 1.0, "dir": "rx", "data": b"ERR CODE=".hex()},
        {"seq": 1, "t": 2.0, "dir": "rx", "data": b"42 id:dut-7\r\n".hex()},
    ]
    capture = {
        "code": {"regex": r"CODE=(\d+)"},
        "unit": {"regex": r"id:(?P<name>[\w-]+)", "group": "name"},
        "whole": {"regex": r"ERR \w+", "group": 0},
        "absent": {"regex": r"NOPE(\d)"},
    }
    verdict = judge.expect(data("bytes", serial), Window(0, 10), {"pattern": r"\r\n"}, capture)
    assert verdict["verdict"] == "pass"
    assert verdict["captures"] == {
        "code": "42",
        "unit": "dut-7",
        "whole": "ERR CODE",
        "absent": None,
    }


def test_expect_captures_record_fields() -> None:
    frames = [
        {"seq": 0, "t": 1.0, "dir": "rx", "id": "0x123", "data": "0102", "fields": {"code": 7}}
    ]
    verdict = judge.expect(
        data("frames", frames),
        Window(0, 10),
        {"id": "0x123"},
        {
            "code": {"field": "fields.code"},
            "payload": {"field": "data"},
            "low": {"field": "data", "regex": "^..(..)$"},
        },
    )
    assert verdict["captures"] == {"code": 7, "payload": "0102", "low": "02"}


def test_captures_are_null_without_a_match() -> None:
    serial = [{"seq": 0, "t": 1.0, "dir": "rx", "data": b"nothing".hex()}]
    verdict = judge.expect(
        data("bytes", serial), Window(0, 10), {"pattern": "OK"}, {"code": {"regex": "(x)"}}
    )
    assert verdict["verdict"] == "fail" and verdict["captures"] == {"code": None}


def test_capture_specs_are_validated() -> None:
    assert judge.capture_error("bytes", {"code": {"regex": r"=(\d+)"}}) is None
    assert judge.capture_error("frames", {"code": {"field": "fields.code"}}) is None
    assert judge.capture_error(None, {"code": {"regex": "x"}}) is None
    assert judge.capture_error("bytes", {})
    assert judge.capture_error("bytes", {"1bad": {"regex": "x"}})
    assert judge.capture_error("bytes", {"code": {"regex": "("}})
    assert judge.capture_error("bytes", {"code": {"regex": "(x)", "group": 2}})
    assert judge.capture_error("bytes", {"code": {"regex": "x", "group": "name"}})
    assert judge.capture_error("bytes", {"code": {"group": 1}})
    assert judge.capture_error("bytes", {"code": {"regex": "x", "other": 1}})
    assert judge.capture_error("scalar", {"code": {"regex": "x"}})  # no text to search


# -- §7.7 evidence grades ------------------------------------------------------------------


def test_every_verdict_carries_an_evidence_type() -> None:
    level = data("scalar", sampled(lambda _t: 1.0, stop=50))
    mean = [{"metric": "mean", "op": "gt", "value": 0}]
    assert judge.observe(level, Window(0, 50), mean)["evidenceType"] == "T1"
    serial = data("bytes", [{"seq": 0, "t": 1.0, "dir": "rx", "data": b"OK".hex()}])
    assert judge.expect(serial, Window(0, 10), {"pattern": "OK"})["evidenceType"] == "P"
    assert judge.guard(level, Window(0, 50), {"op": "lt", "value": 5})["evidenceType"] == "T1"
    assert (
        judge.check_result({"result": {"v": 1}}, [{**mean[0], "metric": "result.v"}])[
            "evidenceType"
        ]
        == "T2"
    )
    declared = data("scalar", level.records, descriptor={"evidenceType": "T3"})
    assert judge.observe(declared, Window(0, 50), mean)["evidenceType"] == "T3"
    assert set(judge.EVIDENCE_TYPES) == {"T1", "T2", "T3", "P", "M", "S"}


def test_setpoint_shadow_never_passes_or_fails() -> None:
    shadow = data(
        "scalar", sampled(lambda _t: 1.0, stop=50), descriptor={"kind": "setpoint", "unit": "V"}
    )
    verdict = judge.observe(shadow, Window(0, 50), [{"metric": "mean", "op": "gt", "value": 0}])
    assert verdict["evidenceType"] == "S"
    assert (verdict["verdict"], verdict["reason"]) == ("inconclusive", "insufficient_evidence")
    assert any("setpoint" in warning for warning in verdict["warnings"])
    assert judge.is_setpoint({"kind": "setpoint"}) and not judge.is_setpoint({"kind": "measured"})
