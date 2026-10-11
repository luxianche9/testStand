"""Pure verdict functions over recorded stream data (design §7.2–7.4).

The engine judges online and ``rejudgeRun`` judges offline by calling the same
functions with the same inputs: records in the stream's service time, the
recorded gaps and the watermark reached. Nothing here touches hardware or I/O.

Verdicts are ``pass`` / ``fail`` / ``inconclusive``; an inconclusive verdict
carries ``reason``: ``watermark_timeout`` (data never covered the window),
``gap`` (the window intersects missing data), ``insufficient_evidence`` (too
few samples, window shorter than twice the inferred resolution, unknown held
state) or ``clock_uncertainty`` (an anchored window shrank to nothing).
"""

from __future__ import annotations

import math
import re
import statistics
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from teststand_backend.util import Record

from .data import StreamData

PASS, FAIL, INCONCLUSIVE = "pass", "fail", "inconclusive"
NUMERIC_OPS = ("lt", "le", "gt", "ge", "eq", "ne", "within", "outside")
TEXT_OPS = ("eq", "ne", "matches", "contains")
OPS = NUMERIC_OPS + ("matches", "contains")
MIN_SAMPLES = 3
UNCERTAINTY_WARNING_RATIO = 0.1

SCALAR_METRICS = ("mean", "min", "max", "p2p", "pp", "rms", "std", "first", "last", "count")
# Waveform metrics over scalar/block samples, parameterised by the assertion (§7.4):
# freq/period/duty take ``threshold`` and ``hysteresis`` (half-width of the comparator
# band; defaults: window midpoint and 5% of the peak-to-peak); riseMs/fallMs are 10%..90%
# between ``low`` and ``high`` (defaults: window min and max); settleMs needs ``band``
# (absolute or '1%') around ``target`` (default: last value), counted from the window start.
WAVEFORM_METRICS = ("freq", "period", "duty", "riseMs", "fallMs", "settleMs")
WAVEFORM_PARAMS = ("threshold", "hysteresis", "low", "high", "target", "band")
# Cross-stream metrics (signal vs reference, both scalar/block), see ``compare``.
COMPARE_METRICS = ("delayMs", "phaseDeg", "correlation", "ratio", "meanRatio", "ppRatio")
DEFAULT_HYSTERESIS_RATIO = 0.05
MAX_CORRELATION_POINTS = 1024
PEAK_TIE = 0.01
# Evidence grades (§7.7): T1 independent measurement, T2 instrument self-report,
# T3 instrument's own precision result, P DUT protocol report, M manual, S setpoint shadow.
EVIDENCE_TYPES = ("T1", "T2", "T3", "P", "M", "S")
SETPOINT = "setpoint"
CAPTURE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
CAPTURE_TEXT_LIMIT = 8192
BITS_METRICS = ("first", "last", "count", "edges")
BIT_METRIC = re.compile(r"^bit(\d{1,3})\.(high|low|edges|first|last)$")
BYTES_METRICS = ("count", "rx.text", "tx.text", "rx.hex", "tx.hex", "rx.bytes", "tx.bytes")
FRAME_METRICS = ("count", "rx.count", "tx.count", "last.id", "last.data")
FRAME_ID_METRIC = re.compile(r"^id\.([^.]+)\.(count|last)$")
BLOB_METRICS = ("count", "exists")


# -- validation (static checks share these) ------------------------------------------------


def metric_error(stream_type: str, metric: str) -> str | None:
    if stream_type in {"scalar", "block"}:
        ok = metric in SCALAR_METRICS or metric in WAVEFORM_METRICS
    elif stream_type == "bits":
        ok = metric in BITS_METRICS or bool(BIT_METRIC.match(metric))
    elif stream_type == "bytes":
        ok = metric in BYTES_METRICS
    elif stream_type == "frames":
        ok = metric in FRAME_METRICS or bool(FRAME_ID_METRIC.match(metric))
    elif stream_type == "blob":
        ok = metric in BLOB_METRICS
    else:
        return f"unknown stream type {stream_type!r}"
    return None if ok else f"metric {metric!r} does not apply to {stream_type} streams"


def assertion_error(assertion: Any) -> str | None:
    if not isinstance(assertion, dict):
        return "assertion must be an object {metric, op, value, tolerance?}"
    if not isinstance(assertion.get("metric"), str) or not assertion["metric"]:
        return "assertion.metric must be a non-empty string"
    op = assertion.get("op")
    if op not in OPS:
        return f"assertion.op must be one of {', '.join(OPS)}"
    if "value" not in assertion:
        return "assertion.value is required"
    value, tolerance = assertion["value"], assertion.get("tolerance")
    if op in {"within", "outside"} and tolerance is None and not _is_range(value):
        return f"{op} needs a tolerance or a [low, high] value"
    if tolerance is not None and _tolerance(tolerance, 1.0) is None:
        return "assertion.tolerance must be a non-negative number or a percentage like '1%'"
    if op == "matches":
        try:
            re.compile(str(value))
        except re.error as exc:
            return f"assertion.value is not a valid regex: {exc}"
    return _waveform_params_error(assertion)


def _waveform_params_error(assertion: Record) -> str | None:
    for key in ("threshold", "low", "high", "target", "maxLagMs"):
        if key in assertion and not _is_number(assertion[key]):
            return f"assertion.{key} must be a number"
    if "hysteresis" in assertion and not (
        _is_number(assertion["hysteresis"]) and assertion["hysteresis"] >= 0
    ):
        return "assertion.hysteresis must be a non-negative number"
    if "maxLagMs" in assertion and assertion["maxLagMs"] <= 0:
        return "assertion.maxLagMs must be greater than 0"
    if "band" in assertion and _tolerance(assertion["band"], 1.0) is None:
        return "assertion.band must be a non-negative number or a percentage like '1%'"
    if assertion.get("metric") == "settleMs" and "band" not in assertion:
        return "settleMs needs a band (tolerance around target)"
    return None


def compare_metric_error(metric: str) -> str | None:
    """Cross-stream metrics (§7.4) are judged by ``compare``, not ``observe``."""
    if metric in COMPARE_METRICS:
        return None
    return (
        f"metric {metric!r} is not a cross-stream metric; use one of {', '.join(COMPARE_METRICS)}"
    )


def capture_error(stream_type: str | None, capture: Any) -> str | None:
    """Validate an ``Expect.capture`` map ``{name: {regex?, group?, field?}}`` (§7.5)."""
    if not isinstance(capture, dict) or not capture:
        return "capture must be a non-empty object {name: {regex?, group?, field?}}"
    for name, spec in capture.items():
        where = f"capture.{name}"
        if not isinstance(name, str) or not CAPTURE_NAME.fullmatch(name):
            return f"capture name {name!r} must be an identifier (letters, digits, _)"
        if not isinstance(spec, dict) or not spec or set(spec) - {"regex", "group", "field"}:
            return f"{where} must be an object with regex, group and/or field"
        if "field" in spec and (not isinstance(spec["field"], str) or not spec["field"]):
            return f"{where}.field must be a non-empty dotted path"
        if "regex" not in spec:
            if "field" not in spec:
                return f"{where} needs a regex or a field"
            if "group" in spec:
                return f"{where}.group needs a regex"
            continue
        try:
            pattern = re.compile(str(spec["regex"]))
        except re.error as exc:
            return f"{where}.regex is not a valid regex: {exc}"
        group = spec.get("group")
        if group is not None and not (
            (isinstance(group, str) and group in pattern.groupindex)
            or (
                isinstance(group, int)
                and not isinstance(group, bool)
                and 0 <= group <= pattern.groups
            )
        ):
            return f"{where}.group must name or number a group of the regex"
        if "field" not in spec and stream_type is not None and stream_type != "bytes":
            return f"{where}: a regex without field only applies to bytes streams (text)"
    return None


def match_error(stream_type: str, match: Any, *, condition: bool = False) -> str | None:
    """Validate an ``Expect`` match or a ``Guard`` condition for the stream type."""
    what = "condition" if condition else "match"
    if not isinstance(match, dict):
        return f"{what} must be an object"
    if stream_type in {"scalar", "block"}:
        if match.get("op") not in NUMERIC_OPS[:6] or not _is_number(match.get("value")):
            return f"{what} for {stream_type} is {{op: lt|le|gt|ge|eq|ne, value: number}}"
    elif stream_type == "bits":
        if (
            not isinstance(match.get("bit"), int)
            or isinstance(match.get("bit"), bool)
            or (match["bit"] < 0 or not isinstance(match.get("level"), bool))
        ):
            return f"{what} for bits is {{bit: integer >= 0, level: boolean}}"
    elif stream_type == "bytes":
        if match.get("dir", "rx") not in {"rx", "tx"}:
            return f"{what}.dir must be rx or tx"
        if ("pattern" in match) == ("hex" in match):
            return f"{what} for bytes needs exactly one of pattern (regex) or hex"
        if "pattern" in match:
            try:
                re.compile(str(match["pattern"]))
            except re.error as exc:
                return f"{what}.pattern is not a valid regex: {exc}"
        elif not _is_hex(match["hex"]):
            return f"{what}.hex must be hexadecimal"
    elif stream_type == "frames":
        if match.get("dir", "rx") not in {"rx", "tx"}:
            return f"{what}.dir must be rx or tx"
        for key in ("data", "mask"):
            if key in match and not _is_hex(match[key]):
                return f"{what}.{key} must be hexadecimal"
        if "message" in match and not isinstance(match["message"], str):
            return f"{what}.message must be a message name"
        if "fields" in match and not isinstance(match["fields"], dict):
            return f"{what}.fields must be an object of decoded field values"
    elif stream_type != "blob":
        return f"unknown stream type {stream_type!r}"
    return None


# -- inputs --------------------------------------------------------------------------------


def evidence_type(stream_type: str, descriptor: Record | None = None) -> str:
    """Evidence grade (§7.7) of a verdict judged on one stream.

    An explicit descriptor ``evidenceType`` wins; ``kind: setpoint`` is ``S``; otherwise
    DUT traffic (bytes/frames) is ``P``, instrument results (blob) ``T3`` and sampled
    levels (scalar/block/bits) ``T1``.
    """
    info = descriptor or {}
    declared = info.get("evidenceType")
    if isinstance(declared, str) and declared in EVIDENCE_TYPES:
        return declared
    if info.get("kind") == SETPOINT:
        return "S"
    if stream_type in {"bytes", "frames"}:
        return "P"
    if stream_type == "blob":
        return "T3"
    return "T1"


def is_setpoint(descriptor: Record | None) -> bool:
    return evidence_type("", descriptor) == "S"


@dataclass(frozen=True)
class Anchor:
    t: float
    hardware_id: str
    clock: Record


@dataclass(frozen=True)
class Window:
    t0: float
    t1: float
    uncertainty_ms: float = 0.0
    warnings: tuple[str, ...] = ()

    def as_record(self, clock: Record) -> Record:
        offset = clock.get("offsetMs")
        record: Record = {"t0": round(self.t0, 3), "t1": round(self.t1, 3)}
        if isinstance(offset, (int, float)):
            record["tb0"] = round(self.t0 - offset, 3)
            record["tb1"] = round(self.t1 - offset, 3)
        if self.uncertainty_ms:
            record["uncertaintyMs"] = round(self.uncertainty_ms, 3)
        return record


def map_window(
    anchor: Anchor,
    hardware_id: str,
    stream_clock: Record,
    start_ms: float,
    end_ms: float,
    *,
    shrink: bool = True,
) -> Window:
    """Anchor-relative window in the stream's service time.

    Same service: no conversion. Another service: convert through backend time
    and (``shrink``) pull both ends in by the combined uncertainty.
    """
    if anchor.hardware_id == hardware_id:
        return Window(anchor.t + start_ms, anchor.t + end_ms)
    offset_a, offset_s = anchor.clock.get("offsetMs"), stream_clock.get("offsetMs")
    if not isinstance(offset_a, (int, float)) or not isinstance(offset_s, (int, float)):
        return Window(math.nan, math.nan, math.inf, ("clock offset unknown",))
    uncertainty = float(anchor.clock.get("uncertaintyMs") or 0.0) + float(
        stream_clock.get("uncertaintyMs") or 0.0
    )
    center = anchor.t - float(offset_a) + float(offset_s)
    t0, t1 = center + start_ms, center + end_ms
    warnings: list[str] = []
    length = end_ms - start_ms
    if shrink:
        t0, t1 = t0 + uncertainty, t1 - uncertainty
    if length > 0 and uncertainty > UNCERTAINTY_WARNING_RATIO * length:
        warnings.append(
            f"clock uncertainty {uncertainty:.1f} ms exceeds 10% of the {length:g} ms window"
        )
    return Window(t0, t1, uncertainty, tuple(warnings))


# -- verdicts ------------------------------------------------------------------------------


def observe(
    data: StreamData,
    window: Window,
    assertions: list[Record],
    *,
    min_samples: int = MIN_SAMPLES,
) -> Record:
    """Statistics of a stream over ``window`` checked against ``assertions``."""
    return _graded(data, _observe(data, window, assertions, min_samples=min_samples))


def _observe(
    data: StreamData,
    window: Window,
    assertions: list[Record],
    *,
    min_samples: int,
) -> Record:
    t0, t1 = window.t0, window.t1
    evidence: Record = {"window": window.as_record(data.clock), "streamType": data.stream_type}
    if window.warnings:
        evidence["warnings"] = list(window.warnings)
    early = _coverage(data, t0, t1, evidence, shrunk=window.uncertainty_ms > 0)
    if early:
        return early
    kind = data.stream_type
    held: Record | None = None
    overrides: dict[int, Record] = {}
    if kind in {"scalar", "block"}:
        samples = _numeric_points(data.records, kind)
        inside = [point for point in samples if t0 <= point["t"] <= t1]
        resolution = resolution_ms(point["t"] for point in samples)
        evidence.update(samples=len(inside), resolutionMs=_round(resolution))
        if len(inside) < min_samples:
            return _verdict(
                INCONCLUSIVE,
                evidence,
                "insufficient_evidence",
                f"{len(inside)} samples in the window, need {min_samples}",
            )
        if resolution is not None and t1 - t0 < 2 * resolution:
            return _verdict(
                INCONCLUSIVE,
                evidence,
                "insufficient_evidence",
                f"window {t1 - t0:g} ms is shorter than twice the "
                f"{resolution:g} ms sample interval",
            )
        metrics = scalar_metrics([point["v"] for point in inside])
        overrides = waveform_results(inside, t0, assertions)
        for index, override in overrides.items():
            metrics[str(assertions[index]["metric"])] = override["actual"]
        if any(assertions[index]["metric"] in {"riseMs", "fallMs"} for index in overrides):
            evidence.setdefault("warnings", []).append(
                f"riseMs/fallMs resolution is limited by the {_round(resolution)} ms "
                "sample interval"
            )
    elif kind == "bits":
        held = _held(data.records, t0)
        inside = [record for record in data.records if t0 < record["t"] <= t1]
        evidence.update(samples=len(inside) + (1 if held else 0))
        if held is None:
            return _verdict(
                INCONCLUSIVE,
                evidence,
                "insufficient_evidence",
                "no bits record at or before the window start",
            )
        metrics = bits_metrics(held, inside, _requested_bits(assertions))
    else:
        inside = [record for record in data.records if t0 <= record["t"] <= t1]
        evidence.update(samples=len(inside))
        metrics = event_metrics(kind, inside, assertions)
    results = check_assertions(metrics, assertions)
    for index, override in overrides.items():
        results[index].update(override)
    evidence["metrics"] = {key: metrics.get(key) for key in _metric_names(assertions, metrics)}
    evidence["assertions"] = results
    if inside:
        evidence["seqRange"] = [inside[0].get("seq"), inside[-1].get("seq")]
    if any(result["passed"] is None for result in results):
        return _verdict(
            INCONCLUSIVE, evidence, "insufficient_evidence", "a metric has no value in the window"
        )
    return _verdict(PASS if all(result["passed"] for result in results) else FAIL, evidence)


def expect(
    data: StreamData, window: Window, match: Record, capture: Record | None = None
) -> Record:
    """First record in ``window`` matching ``match``; fail if none by the window end.

    With ``capture`` the result also carries ``captures`` (§7.5, see ``apply_capture``).
    """
    result = _graded(data, _expect(data, window, match))
    return apply_capture(result, capture) if capture else result


def _expect(data: StreamData, window: Window, match: Record) -> Record:
    t0, t1 = window.t0, window.t1
    evidence: Record = {
        "window": window.as_record(data.clock),
        "streamType": data.stream_type,
        "match": match,
    }
    if window.warnings:
        evidence["warnings"] = list(window.warnings)
    if not (t1 >= t0):
        return _verdict(
            INCONCLUSIVE, evidence, "clock_uncertainty", "the conservative window is empty"
        )
    matcher = Matcher(data.stream_type, match)
    held = _held(data.records, t0)
    found: Record | None = held if matcher.prime(held) else None
    for record in data.records if found is None else ():
        if record["t"] < t0 or (record is held and data.stream_type == "bits"):
            continue
        if record["t"] > t1:
            break
        if matcher.feed(record):
            found = record
            break
    if found is not None:
        at = max(float(found["t"]), t0)
        evidence.update(matchT=at, latencyMs=_round(at - t0), record=_slim(found))
        if data.stream_type == "bytes":
            # What the pattern was searched in: capture regexes run over the same text.
            evidence["text"] = matcher.text[-CAPTURE_TEXT_LIMIT:]
        if _gaps_between(data.gaps, t0, at):
            evidence.setdefault("warnings", []).append(
                "data is missing before the match; the first occurrence may be earlier"
            )
        return _verdict(PASS, evidence)
    early = _coverage(data, t0, t1, evidence, shrunk=False)
    if early:
        return early
    return _verdict(FAIL, evidence, message="no matching record before the deadline")


def guard(data: StreamData, window: Window, condition: Record) -> Record:
    """``condition`` held for the whole window (numeric/bits) or its event never occurred."""
    return _graded(data, _guard(data, window, condition))


def _guard(data: StreamData, window: Window, condition: Record) -> Record:
    t0, t1 = window.t0, window.t1
    evidence: Record = {
        "window": window.as_record(data.clock),
        "streamType": data.stream_type,
        "condition": condition,
    }
    watcher = GuardWatch(data.stream_type, condition)
    stateful = data.stream_type in {"scalar", "block", "bits"}
    held = _held(data.records, t0) if stateful else None
    violation = watcher.prime(held)
    for record in data.records:
        if violation is not None or record["t"] > t1:
            break
        if record["t"] > t0 or (record["t"] == t0 and record is not held):
            violation = watcher.feed(record)
    if violation is not None:
        evidence["violation"] = violation
        return _verdict(FAIL, evidence, message=violation["message"])
    early = _coverage(data, t0, t1, evidence, shrunk=False)
    if early:
        return early
    return _verdict(PASS, evidence)


def check_result(value: Any, assertions: list[Record], evidence_type: str = "T2") -> Record:
    """``InvokeTool`` assertions over a call's ``{result, timing, ...}`` by dotted path.

    A tool's own report is instrument self-measurement (``T2``) unless the caller knows
    better (e.g. ``P`` for a DUT reply relayed by the tool).
    """
    metrics = {
        assertion["metric"]: resolve_path(value, assertion["metric"]) for assertion in assertions
    }
    results = check_assertions(metrics, assertions)
    evidence: Record = {"assertions": results, "evidenceType": evidence_type}
    if any(result["passed"] is None for result in results):
        return _verdict(
            INCONCLUSIVE,
            evidence,
            "insufficient_evidence",
            "a result field is missing or not comparable",
        )
    return _verdict(PASS if all(result["passed"] for result in results) else FAIL, evidence)


def compare(
    signal: StreamData,
    reference: StreamData,
    signal_window: Window,
    reference_window: Window,
    assertions: list[Record],
    *,
    same_clock: bool = False,
    min_samples: int = MIN_SAMPLES,
) -> Record:
    """Cross-stream metrics of ``signal`` against ``reference`` (§7.4), both scalar/block.

    Each window is in its own stream's service time. Samples are compared in backend time
    (``t - clock.offsetMs``) unless ``same_clock`` (both streams on one service). Across
    services the two clock uncertainties add up to ``clockUncertaintyMs``; a ``delayMs`` or
    ``phaseDeg`` assertion whose outcome flips within that uncertainty is inconclusive
    (``clock_uncertainty``). ``delayMs`` > 0 means the signal lags the reference; it comes
    from the cross-correlation peak (``correlation``) searched within ``maxLagMs`` (default:
    half the common span). ``phaseDeg`` scales it by the reference period. ``ratio`` is the
    RMS ratio, ``meanRatio``/``ppRatio`` the ratios of means and peak-to-peak values.
    """
    evidence: Record = {
        "window": signal_window.as_record(signal.clock),
        "referenceWindow": reference_window.as_record(reference.clock),
        "streamType": signal.stream_type,
        "referenceStreamType": reference.stream_type,
        "evidenceType": _weakest(
            evidence_type(signal.stream_type, signal.descriptor),
            evidence_type(reference.stream_type, reference.descriptor),
        ),
    }
    warnings = [*signal_window.warnings, *reference_window.warnings]
    if warnings:
        evidence["warnings"] = warnings
    for data in (signal, reference):
        if data.stream_type not in {"scalar", "block"}:
            return _verdict(
                INCONCLUSIVE,
                evidence,
                "insufficient_evidence",
                f"cross-stream metrics need scalar or block streams, not {data.stream_type}",
            )
    for data, window in ((signal, signal_window), (reference, reference_window)):
        early = _coverage(data, window.t0, window.t1, evidence, shrunk=window.uncertainty_ms > 0)
        if early:
            return early
    uncertainty = 0.0
    shifts = [0.0, 0.0]
    if not same_clock:
        offsets = [signal.clock.get("offsetMs"), reference.clock.get("offsetMs")]
        if not all(_is_number(offset) for offset in offsets):
            return _verdict(
                INCONCLUSIVE, evidence, "clock_uncertainty", "a stream's clock offset is unknown"
            )
        shifts = [_number_or(offset, 0.0) for offset in offsets]
        uncertainty = float(signal.clock.get("uncertaintyMs") or 0.0) + float(
            reference.clock.get("uncertaintyMs") or 0.0
        )
    evidence["clockUncertaintyMs"] = _round(uncertainty)
    series: list[list[tuple[float, float]]] = []
    for data, window, shift in (
        (signal, signal_window, shifts[0]),
        (reference, reference_window, shifts[1]),
    ):
        points = [
            (float(point["t"]) - shift, float(point["v"]))
            for point in _numeric_points(data.records, data.stream_type)
            if window.t0 <= point["t"] <= window.t1
        ]
        series.append(points)
    sig, ref = series
    evidence["samples"] = [len(sig), len(ref)]
    if min(len(sig), len(ref)) < min_samples:
        return _verdict(
            INCONCLUSIVE,
            evidence,
            "insufficient_evidence",
            f"{len(sig)}/{len(ref)} samples in the windows, need {min_samples}",
        )
    metrics: Record = {}
    names = {str(assertion.get("metric")) for assertion in assertions}
    s_stats, r_stats = scalar_metrics([v for _, v in sig]), scalar_metrics([v for _, v in ref])
    metrics["ratio"] = _ratio(s_stats["rms"], r_stats["rms"])
    metrics["meanRatio"] = _ratio(s_stats["mean"], r_stats["mean"])
    metrics["ppRatio"] = _ratio(s_stats["pp"], r_stats["pp"])
    max_lag = next(
        (float(a["maxLagMs"]) for a in assertions if _is_number(a.get("maxLagMs"))), None
    )
    period: float | None = None
    if names & {"delayMs", "phaseDeg", "correlation"}:
        delay, peak = cross_correlation_delay(sig, ref, max_lag)
        metrics["delayMs"], metrics["correlation"] = _round(delay), _round(peak)
        if delay is not None and "phaseDeg" in names:
            period, _ = _period_of(ref, {})
            metrics["phaseDeg"] = None if period is None else _round(_wrap(delay / period * 360))
    results = check_assertions(metrics, assertions)
    ambiguous = False
    for result in results:
        metric, actual = result["metric"], result["actual"]
        if metric not in {"delayMs", "phaseDeg"} or not uncertainty or not _is_number(actual):
            continue
        spread = uncertainty if metric == "delayMs" else uncertainty / (period or math.inf) * 360
        result["uncertainty"] = _round(spread)
        low = evaluate(actual - spread, result)
        high = evaluate(actual + spread, result)
        if low != high or low != result["passed"]:
            result["passed"] = None
            ambiguous = True
    evidence["metrics"] = {
        key: metrics.get(key) for key in dict.fromkeys(r["metric"] for r in results)
    }
    evidence["assertions"] = results
    if ambiguous:
        return _verdict(
            INCONCLUSIVE,
            evidence,
            "clock_uncertainty",
            "the clock uncertainty between the two services could change the outcome",
        )
    if any(result["passed"] is None for result in results):
        return _verdict(
            INCONCLUSIVE, evidence, "insufficient_evidence", "a metric has no value in the window"
        )
    return _verdict(PASS if all(result["passed"] for result in results) else FAIL, evidence)


def apply_capture(result: Record, capture: Record | None) -> Record:
    """Add ``captures`` (§7.5) to an ``Expect`` result from its matched ``record``.

    ``{field}`` takes a dotted path of the record (``data``, ``fields.code`` ...);
    ``{regex, group?}`` searches the bytes ``text`` (or ``str(field)`` when a field is
    given) and keeps ``group`` (default: 1 if the regex has groups, else the whole match).
    Without a match every capture is ``None``, so later references stay well-defined.
    """
    if not capture:
        return result
    record = result.get("record") if result.get("verdict") == PASS else None
    captures: Record = {}
    for name, spec in capture.items():
        captures[str(name)] = (
            None if not isinstance(record, dict) else _capture_one(record, result, spec)
        )
    return {**result, "captures": captures}


def _capture_one(record: Record, result: Record, spec: Any) -> Any:
    if not isinstance(spec, dict):
        return None
    path = spec.get("field")
    has_field = isinstance(path, str) and bool(path)
    source = resolve_path(record, str(path)) if has_field else result.get("text")
    if "regex" not in spec:
        return source
    if source is None:
        return None
    try:
        pattern = re.compile(str(spec["regex"]), re.DOTALL)
    except re.error:
        return None
    found = pattern.search(source if isinstance(source, str) else str(source))
    if found is None:
        return None
    group = spec.get("group", 1 if pattern.groups else 0)
    try:
        return found.group(group)
    except (IndexError, re.error):
        return None


def _graded(data: StreamData, result: Record) -> Record:
    """Attach ``evidenceType``; a setpoint shadow never passes or fails anything (§7.7)."""
    grade = evidence_type(data.stream_type, data.descriptor)
    result = {**result, "evidenceType": grade}
    if grade == "S" and result.get("verdict") in {PASS, FAIL}:
        result["warnings"] = [
            *result.get("warnings", []),
            f"would have been {result['verdict']} on a setpoint shadow stream",
        ]
        result.update(
            verdict=INCONCLUSIVE,
            reason="insufficient_evidence",
            message="a setpoint shadow stream is display-only, not judgement evidence",
        )
    return result


def _weakest(*grades: str) -> str:
    """The grade a combined verdict can claim: ``S`` taints, then P, T3, T2, T1."""
    order = ("S", "M", "P", "T3", "T2", "T1")
    return min(grades, key=lambda grade: order.index(grade) if grade in order else 0)


# -- waveform metrics ----------------------------------------------------------------------


def waveform_results(
    inside: list[Record], t0: float, assertions: list[Record]
) -> dict[int, Record]:
    """Per-assertion ``{actual, passed, waveform}`` for parameterised waveform metrics."""
    points = [(float(point["t"]), float(point["v"])) for point in inside]
    output: dict[int, Record] = {}
    for index, assertion in enumerate(assertions):
        metric = assertion.get("metric")
        if metric not in WAVEFORM_METRICS or not points:
            continue
        details: Record = {}
        passed: bool | None
        if metric in {"freq", "period", "duty"}:
            period, details = _period_of(points, assertion)
            if metric == "period":
                actual = _round(period)
            elif metric == "freq":
                actual = None if not period else 1000.0 / period
            else:
                actual = details.pop("duty", None)
        elif metric in {"riseMs", "fallMs"}:
            actual, details = _transition_ms(points, assertion, rising=metric == "riseMs")
        else:
            actual, details = _settle_ms(points, t0, assertion)
        if metric == "settleMs" and actual is None and "notSettledAfterMs" in details:
            passed = _censored(float(details["notSettledAfterMs"]), assertion)
        else:
            passed = evaluate(actual, assertion)
        output[index] = {"actual": actual, "passed": passed, "waveform": details}
    return output


def _levels(points: list[tuple[float, float]], assertion: Record) -> tuple[float, float]:
    """Comparator ``(threshold, hysteresis)``: explicit, or midpoint and 5% of p2p."""
    values = [v for _, v in points]
    low, high = min(values), max(values)
    return (
        _number_or(assertion.get("threshold"), (low + high) / 2),
        _number_or(assertion.get("hysteresis"), DEFAULT_HYSTERESIS_RATIO * (high - low)),
    )


def edges(
    points: list[tuple[float, float]], threshold: float, hysteresis: float
) -> list[tuple[float, bool]]:
    """``[(t, rising)]`` of a hysteresis comparator; ``t`` interpolated at ``threshold``."""
    upper, lower = threshold + hysteresis, threshold - hysteresis
    state: bool | None = None
    output: list[tuple[float, bool]] = []
    last = 0
    for index, (_, v) in enumerate(points):
        rising = state is not True and v >= upper
        falling = state is not False and v < lower
        if not (rising or falling):
            continue
        if state is not None:
            output.append((_crossing(points, last, index, threshold, rising), rising))
        state, last = rising, index
    return output


def _crossing(
    points: list[tuple[float, float]], start: int, end: int, level: float, rising: bool
) -> float:
    """Latest interpolated time in ``points[start..end]`` the signal crosses ``level``."""
    for j in range(end, max(start, 1) - 1, -1):
        (ta, va), (tb, vb) = points[j - 1], points[j]
        crossed = va < level <= vb if rising else va >= level > vb
        if crossed and vb != va:
            return ta + (level - va) * (tb - ta) / (vb - va)
    return points[end][0]


def _period_of(points: list[tuple[float, float]], assertion: Record) -> tuple[float | None, Record]:
    threshold, hysteresis = _levels(points, assertion)
    found = edges(points, threshold, hysteresis)
    details: Record = {
        "threshold": _round(threshold),
        "hysteresis": _round(hysteresis),
        "edges": len(found),
    }
    rises = [t for t, rising in found if rising]
    falls = [t for t, rising in found if not rising]
    marks = rises if len(rises) >= 2 else falls
    if len(marks) < 2:
        return None, details
    period = (marks[-1] - marks[0]) / (len(marks) - 1)
    if len(rises) >= 2:
        high = 0.0
        for start, stop in zip(rises, rises[1:], strict=False):
            fall = next((t for t in falls if start < t < stop), None)
            if fall is None:
                return period, details
            high += fall - start
        details["duty"] = high / (rises[-1] - rises[0])
    return period, details


def _transition_ms(
    points: list[tuple[float, float]], assertion: Record, *, rising: bool
) -> tuple[float | None, Record]:
    """First 10%→90% (rising) or 90%→10% (falling) transition time between low and high."""
    values = [v for _, v in points]
    low = float(assertion["low"]) if _is_number(assertion.get("low")) else min(values)
    high = float(assertion["high"]) if _is_number(assertion.get("high")) else max(values)
    details: Record = {"low": _round(low), "high": _round(high)}
    if high <= low:
        return None, details
    if not rising:  # a fall is a rise of the mirrored signal
        points = [(t, -v) for t, v in points]
        low, high = -high, -low
    p10, p90 = low + 0.1 * (high - low), low + 0.9 * (high - low)
    armed = points[0][1] < p10
    t10: float | None = None
    for (ta, va), (tb, vb) in zip(points, points[1:], strict=False):
        if armed and va < p10 <= vb:
            t10 = ta + (p10 - va) * (tb - ta) / (vb - va)
        if armed and t10 is not None and va < p90 <= vb:
            return _round(ta + (p90 - va) * (tb - ta) / (vb - va) - t10), details
        if vb < p10:
            armed, t10 = True, None
    return None, details


def _settle_ms(
    points: list[tuple[float, float]], t0: float, assertion: Record
) -> tuple[float | None, Record]:
    """Time from the window start until the signal enters ``target ± band`` for good."""
    target = float(assertion["target"]) if _is_number(assertion.get("target")) else points[-1][1]
    band = _tolerance(assertion.get("band", 0), target) or 0.0
    details: Record = {"target": _round(target), "band": _round(band)}
    outside = [i for i, (_, v) in enumerate(points) if abs(v - target) > band]
    if not outside:
        return _round(max(0.0, points[0][0] - t0)), details
    last = outside[-1]
    if last == len(points) - 1:
        details["notSettledAfterMs"] = _round(points[last][0] - t0)
        return None, details
    (ta, va), (tb, vb) = points[last], points[last + 1]
    edge = target + band if va > target else target - band
    entered = ta + (edge - va) * (tb - ta) / (vb - va) if vb != va else tb
    return _round(entered - t0), details


def _censored(lower: float, assertion: Record) -> bool | None:
    """Judge a value only known to exceed ``lower`` (a signal that never settled)."""
    op, expected = assertion["op"], assertion["value"]
    if op in {"lt", "le", "gt", "ge"}:
        if not _is_number(expected) or float(expected) > lower:
            return None
        return op in {"gt", "ge"}
    bounds = _bounds(expected, assertion.get("tolerance"))
    if bounds is None or bounds[1] > lower:
        return None
    return op in {"outside", "ne"}


def cross_correlation_delay(
    signal: list[tuple[float, float]],
    reference: list[tuple[float, float]],
    max_lag_ms: float | None = None,
) -> tuple[float | None, float | None]:
    """``(delayMs, peak correlation)`` of ``signal`` relative to ``reference``.

    Both series are resampled on a common grid over their overlap (at most
    ``MAX_CORRELATION_POINTS`` points), then the normalised correlation is searched over
    lags within ``max_lag_ms`` and the peak refined by a parabola through its neighbours.
    A periodic signal correlates once per period, so among local peaks scoring within
    ``PEAK_TIE`` of the best the smallest lag wins (narrow ``max_lag_ms`` to disambiguate).
    """
    start = max(signal[0][0], reference[0][0])
    stop = min(signal[-1][0], reference[-1][0])
    steps = [
        step
        for step in (resolution_ms(t for t, _ in signal), resolution_ms(t for t, _ in reference))
        if step
    ]
    if stop <= start or not steps:
        return None, None
    dt = max(max(steps), (stop - start) / (MAX_CORRELATION_POINTS - 1))
    count = int((stop - start) / dt) + 1
    if count < 4:
        return None, None
    grid = [start + i * dt for i in range(count)]
    s, r = _resample(signal, grid), _resample(reference, grid)
    lag_limit = min(count - 2, int((max_lag_ms if max_lag_ms else (stop - start) / 2) / dt))
    scores: dict[int, float] = {}
    for lag in range(-lag_limit, lag_limit + 1):
        pairs = [(s[i + lag], r[i]) for i in range(max(0, -lag), min(count, count - lag))]
        scores[lag] = _pearson(pairs)
    top = max(scores.values())
    if not math.isfinite(top):
        return None, None
    peaks = [
        lag
        for lag, score in scores.items()
        if score >= top - PEAK_TIE
        and score >= scores.get(lag - 1, -math.inf)
        and score >= scores.get(lag + 1, -math.inf)
    ]
    best = min(peaks, key=abs)
    peak = scores[best]
    shift = 0.0
    if best - 1 in scores and best + 1 in scores:
        left, right = scores[best - 1], scores[best + 1]
        curvature = left - 2 * peak + right
        # An edge lag too short to score is -inf: keep the integer peak then.
        if math.isfinite(left) and math.isfinite(right) and curvature < 0:
            shift = 0.5 * (left - right) / curvature
    return (best + shift) * dt, peak


def _resample(points: list[tuple[float, float]], grid: list[float]) -> list[float]:
    output: list[float] = []
    j = 0
    for t in grid:
        while j < len(points) - 2 and points[j + 1][0] < t:
            j += 1
        (ta, va), (tb, vb) = points[j], points[min(j + 1, len(points) - 1)]
        output.append(va if tb == ta else va + (vb - va) * (t - ta) / (tb - ta))
    return output


def _pearson(pairs: list[tuple[float, float]]) -> float:
    if len(pairs) < 3:
        return -math.inf
    mean_a = statistics.fmean(a for a, _ in pairs)
    mean_b = statistics.fmean(b for _, b in pairs)
    cov = sum((a - mean_a) * (b - mean_b) for a, b in pairs)
    var_a = sum((a - mean_a) ** 2 for a, _ in pairs)
    var_b = sum((b - mean_b) ** 2 for _, b in pairs)
    return cov / math.sqrt(var_a * var_b) if var_a > 0 and var_b > 0 else -math.inf


def _ratio(numerator: Any, denominator: Any) -> float | None:
    if not (_is_number(numerator) and _is_number(denominator)) or denominator == 0:
        return None
    return float(numerator) / float(denominator)


def _wrap(degrees: float) -> float:
    wrapped = math.fmod(degrees + 180.0, 360.0)
    return (wrapped + 360.0 if wrapped <= 0 else wrapped) - 180.0


# -- online helpers ------------------------------------------------------------------------


class Matcher:
    """Incremental ``Expect`` matching (bytes accumulate text from the window start)."""

    def __init__(self, stream_type: str, match: Record) -> None:
        self.kind, self.match = stream_type, match
        self._text = ""
        self._previous: int | None = None
        if stream_type == "bytes":
            self.dir = match.get("dir", "rx")
            self.pattern = re.compile(
                str(match["pattern"])
                if "pattern" in match
                else re.escape(bytes.fromhex(str(match["hex"])).decode("latin-1")),
                re.DOTALL,
            )
        if stream_type == "frames":
            self.dir = match.get("dir", "rx")

    @property
    def text(self) -> str:
        """Bytes streams: the text accumulated from the window start (latin-1)."""
        return self._text

    def prime(self, held: Record | None) -> bool:
        """Feed the state held at the window start; ``True`` if a level match already holds."""
        if self.kind == "bits" and held is not None:
            self._previous = _bit(held, self.match["bit"])
            return self.match.get("edge") is False and self._previous == int(self.match["level"])
        return False

    def feed(self, record: Record) -> bool:
        kind, match = self.kind, self.match
        if kind in {"scalar", "block"}:
            values = [record["v"]] if kind == "scalar" else list(record.get("samples", []))
            return any(_compare(value, match["op"], match["value"]) for value in values)
        if kind == "bits":
            level = _bit(record, match["bit"])
            before, self._previous = self._previous, level
            wanted = int(match["level"])
            if match.get("edge") is False:
                return level == wanted
            return level == wanted and before is not None and before != wanted
        if kind == "bytes":
            if record.get("dir") != self.dir:
                return False
            self._text += bytes.fromhex(record.get("data") or "").decode("latin-1")
            return self.pattern.search(self._text) is not None
        if kind == "frames":
            return record.get("dir") == self.dir and _frame_matches(record, match)
        return True  # blob: any record


class GuardWatch:
    """Incremental ``Guard`` check; ``feed`` returns a violation record or ``None``."""

    def __init__(self, stream_type: str, condition: Record) -> None:
        self.kind, self.condition = stream_type, condition
        self.forbidden = (
            Matcher(stream_type, {**condition, "edge": False})
            if stream_type in {"bytes", "frames", "blob"}
            else None
        )

    def prime(self, held: Record | None) -> Record | None:
        if held is not None and self.kind in {"scalar", "block", "bits"}:
            return self.feed(held)
        return None

    def feed(self, record: Record) -> Record | None:
        condition = self.condition
        if self.forbidden is not None:
            if self.forbidden.feed(record):
                return {
                    "t": record["t"],
                    "record": _slim(record),
                    "message": "forbidden event occurred",
                }
            return None
        if self.kind in {"scalar", "block"}:
            values = [record["v"]] if self.kind == "scalar" else list(record.get("samples", []))
            for value in values:
                if not _compare(value, condition["op"], condition["value"]):
                    return {
                        "t": record["t"],
                        "value": value,
                        "record": _slim(record),
                        "message": f"value {value} is not {condition['op']} {condition['value']}",
                    }
            return None
        level = _bit(record, condition["bit"])
        if level != int(condition["level"]):
            return {
                "t": record["t"],
                "mask": record.get("mask"),
                "record": _slim(record),
                "message": f"bit {condition['bit']} left level {int(condition['level'])}",
            }
        return None


# -- metrics -------------------------------------------------------------------------------


def scalar_metrics(values: list[float]) -> Record:
    if not values:
        return {"count": 0, **{key: None for key in SCALAR_METRICS if key != "count"}}
    low, high = min(values), max(values)
    return {
        "mean": statistics.fmean(values),
        "min": low,
        "max": high,
        "p2p": high - low,
        "pp": high - low,
        "rms": math.sqrt(statistics.fmean(value * value for value in values)),
        "std": statistics.pstdev(values) if len(values) > 1 else 0.0,
        "first": values[0],
        "last": values[-1],
        "count": len(values),
    }


def bits_metrics(held: Record, inside: list[Record], bits: Iterable[int]) -> Record:
    masks = [int(held["mask"])] + [int(record["mask"]) for record in inside]
    metrics: Record = {
        "first": masks[0],
        "last": masks[-1],
        "count": len(inside),
        "edges": sum(1 for a, b in zip(masks, masks[1:], strict=False) if a != b),
    }
    for bit in bits:
        levels = [(mask >> bit) & 1 for mask in masks]
        metrics[f"bit{bit}.high"] = all(levels)
        metrics[f"bit{bit}.low"] = not any(levels)
        metrics[f"bit{bit}.edges"] = sum(
            1 for a, b in zip(levels, levels[1:], strict=False) if a != b
        )
        metrics[f"bit{bit}.first"], metrics[f"bit{bit}.last"] = levels[0], levels[-1]
    return metrics


def event_metrics(kind: str, inside: list[Record], assertions: list[Record]) -> Record:
    metrics: Record = {"count": len(inside)}
    if kind == "bytes":
        for direction in ("rx", "tx"):
            raw = b"".join(
                bytes.fromhex(record.get("data") or "")
                for record in inside
                if record.get("dir") == direction
            )
            metrics[f"{direction}.text"] = raw.decode("latin-1")
            metrics[f"{direction}.hex"] = raw.hex()
            metrics[f"{direction}.bytes"] = len(raw)
    elif kind == "frames":
        for direction in ("rx", "tx"):
            metrics[f"{direction}.count"] = sum(
                1 for record in inside if record.get("dir") == direction
            )
        last = inside[-1] if inside else None
        metrics["last.id"] = last.get("id") if last else None
        metrics["last.data"] = last.get("data") if last else None
        for assertion in assertions:
            found = FRAME_ID_METRIC.match(str(assertion.get("metric")))
            if found:
                frames = [record for record in inside if _same_id(record.get("id"), found[1])]
                metrics[f"id.{found[1]}.count"] = len(frames)
                metrics[f"id.{found[1]}.last"] = frames[-1].get("data") if frames else None
    elif kind == "blob":
        metrics["exists"] = bool(inside)
    return metrics


def resolution_ms(times: Iterable[float]) -> float | None:
    ordered = sorted(times)
    intervals = [b - a for a, b in zip(ordered, ordered[1:], strict=False) if b > a]
    return statistics.median(intervals) if intervals else None


# -- assertions ----------------------------------------------------------------------------


def check_assertions(metrics: Record, assertions: list[Record]) -> list[Record]:
    results: list[Record] = []
    for assertion in assertions:
        actual = metrics.get(assertion["metric"])
        passed = evaluate(actual, assertion)
        results.append({**assertion, "actual": actual, "passed": passed})
    return results


def evaluate(actual: Any, assertion: Record) -> bool | None:
    """``True``/``False``, or ``None`` when ``actual`` is missing or not comparable."""
    op, expected = assertion["op"], assertion["value"]
    tolerance = assertion.get("tolerance")
    if actual is None:
        return None
    if op in {"matches", "contains"} or (isinstance(actual, str) and op in {"eq", "ne"}):
        text = actual if isinstance(actual, str) else str(actual)
        if op == "matches":
            return re.search(str(expected), text, re.DOTALL) is not None
        if op == "contains":
            return bool(str(expected) in text)
        return bool((text == str(expected)) == (op == "eq"))
    if isinstance(actual, bool) or isinstance(expected, bool):
        if op not in {"eq", "ne"}:
            return None
        return bool((bool(actual) == bool(expected)) == (op == "eq"))
    if not _is_number(actual):
        return None
    value = float(actual)
    if op in {"within", "outside"} or (op in {"eq", "ne"} and tolerance is not None):
        bounds = _bounds(expected, tolerance)
        if bounds is None:
            return None
        inside = bounds[0] <= value <= bounds[1]
        return inside if op in {"within", "eq"} else not inside
    if not _is_number(expected):
        return None
    return _compare(value, op, float(expected))


def _bounds(expected: Any, tolerance: Any) -> tuple[float, float] | None:
    if _is_range(expected):
        low, high = float(expected[0]), float(expected[1])
        return (min(low, high), max(low, high))
    if not _is_number(expected):
        return None
    center = float(expected)
    delta = _tolerance(tolerance if tolerance is not None else 0, center)
    if delta is None:
        return None
    return (center - delta, center + delta)


def _tolerance(tolerance: Any, center: float) -> float | None:
    if isinstance(tolerance, str) and tolerance.strip().endswith("%"):
        try:
            percent = float(tolerance.strip()[:-1])
        except ValueError:
            return None
        return abs(center) * percent / 100 if percent >= 0 else None
    if _is_number(tolerance) and float(tolerance) >= 0:
        return float(tolerance)
    return None


def _compare(value: Any, op: str, expected: Any) -> bool:
    if not _is_number(value):
        return False
    a, b = float(value), float(expected)
    return {
        "lt": a < b,
        "le": a <= b,
        "gt": a > b,
        "ge": a >= b,
        "eq": a == b,
        "ne": a != b,
    }.get(op, False)


def resolve_path(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return None
    return current


# -- internals -----------------------------------------------------------------------------


def _coverage(
    data: StreamData, t0: float, t1: float, evidence: Record, *, shrunk: bool
) -> Record | None:
    if not (t1 >= t0):
        return _verdict(
            INCONCLUSIVE,
            evidence,
            "clock_uncertainty" if shrunk else "insufficient_evidence",
            "the window is empty",
        )
    if data.watermark is None or data.watermark < t1:
        return _verdict(
            INCONCLUSIVE,
            evidence,
            "watermark_timeout",
            "recorded data does not reach the window end",
        )
    hits = _gaps_between(data.gaps, t0, t1)
    if hits:
        evidence["gaps"] = hits
        return _verdict(INCONCLUSIVE, evidence, "gap", "data is missing inside the window")
    return None


def _gaps_between(gaps: list[Record], t0: float, t1: float) -> list[Record]:
    return [
        gap
        for gap in gaps
        if _is_number(gap.get("t0"))
        and _is_number(gap.get("t1"))
        and gap["t0"] < t1
        and gap["t1"] > t0
    ]


def _numeric_points(records: list[Record], kind: str) -> list[Record]:
    if kind == "scalar":
        return [record for record in records if _is_number(record.get("v"))]
    result: list[Record] = []
    for record in records:
        t0, dt = float(record["t0"]), float(record["dt"])
        result.extend(
            {"t": t0 + i * dt, "v": value}
            for i, value in enumerate(record.get("samples", []))
            if _is_number(value)
        )
    return result


def _held(records: list[Record], t: float) -> Record | None:
    held: Record | None = None
    for record in records:
        if record["t"] > t:
            break
        held = record
    return held


def _bit(record: Record, bit: int) -> int:
    return (int(record.get("mask", 0)) >> int(bit)) & 1


def _requested_bits(assertions: list[Record]) -> list[int]:
    bits: list[int] = []
    for assertion in assertions:
        found = BIT_METRIC.match(str(assertion.get("metric")))
        if found and int(found[1]) not in bits:
            bits.append(int(found[1]))
    return bits


def _metric_names(assertions: list[Record], metrics: Record) -> list[str]:
    names = [assertion["metric"] for assertion in assertions]
    return list(
        dict.fromkeys(names + [key for key in ("count", "mean", "min", "max") if key in metrics])
    )


def _frame_matches(record: Record, match: Record) -> bool:
    """``id``/``data``+``mask`` on the wire bytes; ``message``/``fields`` on ICD-decoded frames
    (derived ``alias.<message>`` records carry ``raw`` instead of ``data``, §6.4)."""
    if "id" in match and not _same_id(record.get("id"), match["id"]):
        return False
    if "message" in match and record.get("message") != match["message"]:
        return False
    if "fields" in match:
        fields = record.get("fields") or {}
        if not all(
            name in fields and _same_value(fields[name], value)
            for name, value in match["fields"].items()
        ):
            return False
    if "data" not in match:
        return True
    data = bytes.fromhex(str(record.get("data") or record.get("raw") or ""))
    wanted = bytes.fromhex(str(match["data"]))
    mask = bytes.fromhex(str(match.get("mask") or "ff" * len(wanted)))
    if len(data) < len(wanted):
        return False
    return all((data[i] & mask[i]) == (wanted[i] & mask[i]) for i in range(len(wanted)))


def _same_value(actual: Any, expected: Any) -> bool:
    """Decoded field equality: numbers numerically, everything else (enum names ...) exactly."""
    if _is_number(actual) and _is_number(expected):
        return math.isclose(float(actual), float(expected), rel_tol=0.0, abs_tol=1e-9)
    return bool(actual == expected)


def _same_id(actual: Any, expected: Any) -> bool:
    def number(value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        try:
            return int(str(value), 0)
        except ValueError:
            try:
                return int(str(value), 16)
            except ValueError:
                return None

    a, b = number(actual), number(expected)
    return a is not None and a == b


def _slim(record: Record) -> Record:
    return {key: value for key, value in record.items() if key != "i"}


def _verdict(
    verdict: str, evidence: Record, reason: str | None = None, message: str | None = None
) -> Record:
    result: Record = {"verdict": verdict, **evidence}
    if reason:
        result["reason"] = reason
    if message:
        result["message"] = message
    return result


def _number_or(value: Any, default: float) -> float:
    return float(value) if _is_number(value) else default


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 3)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_range(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and all(_is_number(item) for item in value)
    )


def _is_hex(value: Any) -> bool:
    text = str(value).replace(" ", "")
    return (
        isinstance(value, str)
        and len(text) % 2 == 0
        and all(char in "0123456789abcdefABCDEF" for char in text)
    )
