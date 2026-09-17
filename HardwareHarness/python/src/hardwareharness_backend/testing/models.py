from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from hardwareharness_backend.compat import clone, new_uuid, utc_now_iso

Record = dict[str, Any]
STEP_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
VERDICTS = ("NotSet", "Pass", "Inconclusive", "Fail", "Aborted", "Error")
VERDICT_RANK = {value: index for index, value in enumerate(VERDICTS)}
CONTAINER_STEPS = {"Sequence", "Group", "If", "Repeat", "ForEach", "Parallel", "Retry"}
BUILTIN_STEPS = {
    *CONTAINER_STEPS,
    "SetVariable",
    "Evaluate",
    "Delay",
    "WaitUntil",
    "InvokeTool",
    "Equal",
    "Range",
    "Tolerance",
    "Bitmask",
    "PublishResult",
}


def empty_plan(name: str = "Untitled test plan", plan_id: str | None = None) -> Record:
    return {
        "schemaVersion": 1,
        "id": plan_id or new_uuid(),
        "name": name,
        "description": "",
        "revision": 1,
        "parameters": [],
        "stopOnFail": False,
        "regions": {"prepare": [], "test": [], "cleanup": []},
        "createdAt": utc_now_iso(),
        "updatedAt": utc_now_iso(),
    }


def schema_hash(schema: Any) -> str:
    encoded = json.dumps(schema, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def iter_steps(plan: Record) -> list[tuple[str, Record]]:
    output: list[tuple[str, Record]] = []

    def visit(steps: Any, path: str) -> None:
        if not isinstance(steps, list):
            return
        for index, step in enumerate(steps):
            current = f"{path}/{index}"
            if isinstance(step, dict):
                output.append((current, step))
                visit(step.get("children", []), current + "/children")
                visit(step.get("elseChildren", []), current + "/elseChildren")

    regions = plan.get("regions", {})
    for region in ("prepare", "test", "cleanup"):
        visit(regions.get(region, []), f"/regions/{region}")
    return output


def plan_hardware_ids(plan: Record) -> list[str]:
    return sorted(
        {
            str(step["hardwareId"])
            for _, step in iter_steps(plan)
            if step.get("type") == "InvokeTool" and isinstance(step.get("hardwareId"), str)
        }
    )


def aggregate_verdict(current: str, incoming: str) -> str:
    return incoming if VERDICT_RANK.get(incoming, 0) > VERDICT_RANK.get(current, 0) else current


def public_plan(plan: Record) -> Record:
    return clone(plan)
