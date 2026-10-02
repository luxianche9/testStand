"""One run on a single backend-time axis: steps, calls, anchors, verdict windows, violations.

Built from the run's events (each carries ``tb``), its results and the stream index of
its stream recording. The run-monitor page draws every lane against the same ``tb`` so the
time cursor can link a step, its call, its window and the recorded samples.
"""

from __future__ import annotations

from typing import Any

Record = dict[str, Any]

_MARKS = {
    "run.started",
    "run.completed",
    "run.aborted",
    "run.error",
    "run.cleanupStarted",
    "run.paused",
    "run.resumed",
    "lease.acquired",
    "lease.lost",
    "lease.unavailable",
    "lease.released",
    "recording.started",
    "streams.unavailable",
    "clock.unavailable",
    "region.started",
    "region.completed",
    "safety.started",
    "safety.completed",
}


def build_timeline(
    run_id: str,
    events: list[Record],
    results: list[Record],
    streams: list[Record],
    gaps: dict[str, list[Record]],
) -> Record:
    steps: dict[str, Record] = {}
    calls: dict[str, Record] = {}
    anchors: list[Record] = []
    violations: list[Record] = []
    marks: list[Record] = []
    offsets = {str(item["key"]): (item.get("clock") or {}).get("offsetMs") for item in streams}
    times: list[float] = []

    for event in events:
        kind, tb = event.get("type"), _num(event.get("tb"))
        if tb is not None:
            times.append(tb)
        if kind == "step.started":
            steps[str(event["executionId"])] = {
                "executionId": event["executionId"],
                "stepId": event.get("stepId"),
                "stepType": event.get("stepType"),
                "region": event.get("region"),
                **(
                    {"parentExecutionId": event["parentExecutionId"]}
                    if event.get("parentExecutionId")
                    else {}
                ),
                "tb0": tb,
                "tb1": None,
                "verdict": None,
            }
        elif kind == "step.completed":
            step = steps.setdefault(
                str(event["executionId"]),
                {
                    "executionId": event["executionId"],
                    "stepId": event.get("stepId"),
                    "stepType": event.get("stepType"),
                    "region": event.get("region"),
                    "tb0": None,
                },
            )
            step.update(tb1=tb, verdict=event.get("verdict"), durationMs=event.get("durationMs"))
            for call in calls.values():
                if call.get("executionId") == event["executionId"] and call["tb1"] is None:
                    call.update(
                        tb1=tb,
                        state="failed"
                        if event.get("verdict") in {"Error", "Aborted"}
                        else call["state"],
                    )
        elif kind == "operation.accepted":
            operation = event.get("operation") or {}
            calls[str(operation.get("operationId"))] = {
                "operationId": operation.get("operationId"),
                "executionId": operation.get("executionId"),
                "stepId": operation.get("stepId"),
                "hardwareId": operation.get("hardwareId"),
                "toolName": operation.get("toolName"),
                "arguments": operation.get("arguments"),
                "tb0": tb,
                "tb1": None,
                "state": "accepted",
            }
        elif kind == "operation.dispatched":
            pending = calls.get(str(event.get("operationId")))
            if pending is not None:
                pending.update(tb0=tb, state="dispatched")
        elif kind == "operation.succeeded":
            pending = calls.get(str(event.get("operationId")))
            if pending is not None:
                timing = event.get("timing") or {}
                pending.update(
                    tb0=_num(timing.get("backendStart"), pending["tb0"]),
                    tb1=_num(timing.get("backendEnd"), tb),
                    state="succeeded",
                    timing=timing,
                )
        elif kind == "anchor.set":
            anchor = event.get("anchor") or {}
            clock = anchor.get("clock") or {}
            offset = _num(clock.get("offsetMs"))
            t = _num(anchor.get("t"))
            anchors.append(
                {
                    "name": anchor.get("name"),
                    "hardwareId": anchor.get("hardwareId"),
                    "t": t,
                    "tb": round(t - offset, 3)
                    if t is not None and offset is not None
                    else (t if anchor.get("hardwareId") == "__backend__" else tb),
                    "stepId": event.get("stepId"),
                    "executionId": event.get("executionId"),
                    **(
                        {"uncertaintyMs": clock["uncertaintyMs"]}
                        if "uncertaintyMs" in clock
                        else {}
                    ),
                }
            )
        elif kind == "guard.violated":
            violation = event.get("violation") or {}
            violations.append(
                {
                    "stepId": event.get("stepId"),
                    "key": event.get("key"),
                    "tb": _violation_tb(violation, offsets.get(str(event.get("key")))) or tb,
                    "onViolation": event.get("onViolation"),
                    "violation": violation,
                }
            )
        elif kind in _MARKS:
            mark: Record = {"type": kind, "tb": tb}
            for field in ("hardwareId", "message", "region"):
                if event.get(field) is not None:
                    mark[field] = event[field]
            marks.append(mark)

    windows = [window for window in (_window(result, offsets) for result in results) if window]
    for window in windows:
        times.extend(value for value in (window["tb0"], window["tb1"]) if value is not None)
    return {
        "runId": run_id,
        "tb0": min(times) if times else None,
        "tb1": max(times) if times else None,
        "steps": list(steps.values()),
        "calls": list(calls.values()),
        "anchors": anchors,
        "windows": windows,
        "violations": violations,
        "marks": marks,
        "streams": streams,
        "gaps": [{"key": key, **gap} for key, items in gaps.items() for gap in items],
    }


def _window(result: Record, offsets: dict[str, Any]) -> Record | None:
    spec = result.get("judge")
    if result.get("kind") != "verdict" or not isinstance(spec, dict):
        return None
    evidence = result.get("evidence") or {}
    shown = evidence.get("window") or {}
    raw = spec.get("window") or {}
    offset = _num(offsets.get(str(spec.get("key"))))
    t0, t1 = _num(raw.get("t0")), _num(raw.get("t1"))

    def backend(value: float | None, recorded: Any) -> float | None:
        if _num(recorded) is not None:
            return _num(recorded)
        return round(value - offset, 3) if value is not None and offset is not None else None

    match_t = _num(evidence.get("matchT"))
    return {
        "sequence": result.get("sequence"),
        "stepId": result.get("sourceStepId"),
        "executionId": result.get("executionId"),
        "name": result.get("name"),
        "type": spec.get("type"),
        "key": spec.get("key"),
        "hardwareId": spec.get("hardwareId"),
        "streamId": spec.get("streamId"),
        "verdict": result.get("verdict"),
        "reason": evidence.get("reason"),
        "message": evidence.get("message"),
        "t0": t0,
        "t1": t1,
        "tb0": backend(t0, shown.get("tb0")),
        "tb1": backend(t1, shown.get("tb1")),
        **({"matchTb": backend(match_t, None)} if match_t is not None else {}),
        **({"uncertaintyMs": raw["uncertaintyMs"]} if raw.get("uncertaintyMs") else {}),
    }


def _violation_tb(violation: Record, offset: Any) -> float | None:
    t, shift = _num(violation.get("t")), _num(offset)
    return round(t - shift, 3) if t is not None and shift is not None else None


def _num(value: Any, default: float | None = None) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return default
