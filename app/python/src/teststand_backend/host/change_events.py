"""What a domain event carries on ``/api/events`` (design §9.4): which resource changed and its
new version, never the resource itself. The interface invalidates the matching queries and
reads the resource again, so a lost event only costs a full refresh, never a stale copy.

Services hand their notifiers whatever they have at hand; :func:`change_summary` reduces it
here, at the one place events leave the process.
"""

from __future__ import annotations

from typing import Any

Record = dict[str, Any]


def change_summary(event: str, payload: Any) -> Record:
    """The resource key and version of ``payload`` for ``event``."""
    data = _record(payload)
    if event == "project":
        file = _record(data.get("file"))
        return _present(
            projectId=file.get("projectId"),
            updatedAt=file.get("updatedAt"),
            dirty=data.get("dirty"),
        ) or {"projectId": None}
    if event == "wiringTask":
        # ``status`` lets the main process flash the window for a new request.
        return _present(
            wiringTaskId=data.get("wiringTaskId"),
            status=data.get("status"),
            updatedAt=data.get("updatedAt"),
        )
    if event == "execution":
        return _present(state=data.get("state"), activityId=data.get("activityId"))
    if event == "confirmation":
        return {"pending": len(payload) if isinstance(payload, list) else 0}
    if event == "testBatch":
        kind = data.get("kind")
        if kind == "batch":
            batch = _record(data.get("batch"))
            return _present(
                kind=kind,
                batchId=batch.get("batchId"),
                state=batch.get("state"),
                updatedAt=batch.get("updatedAt"),
            )
        if kind == "unit":
            unit = _record(data.get("unit"))
            return _present(kind=kind, unitId=unit.get("unitId"))
        return _present(kind=kind)
    # testPlan {planId, revision} and testRun {runId, sequences, state} are already key and
    # version; keep only scalar fields in case they ever grow.
    return {key: value for key, value in data.items() if _scalar(value)}


def _present(**fields: Any) -> Record:
    return {key: value for key, value in fields.items() if value is not None}


def _scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _record(value: Any) -> Record:
    return value if isinstance(value, dict) else {}
