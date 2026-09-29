from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from hardwareharness_backend.application import DefaultAuthorizer, ExecutionCoordinator
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.testing import TestEngine, TestingApplication, TestPlanStore
from hardwareharness_backend.testing.runtime_state import RuntimeStateStore

from .test_testing import HUMAN, Devices, Projects, Resolver, finish

PASS = {"id": "ok", "type": "Equal", "actual": 1, "expected": 1}
FAIL = {"id": "bad", "type": "Equal", "actual": 1, "expected": 2}
SLOW = {"id": "slow", "type": "Delay", "durationMs": 2000}


def make_app(tmp_path: Path, resolver: Resolver | None = None) -> TestingApplication:
    projects = Projects(tmp_path)
    resolver = resolver or Resolver()
    engine = TestEngine(projects, Devices(), resolver, ExecutionCoordinator())
    return TestingApplication(
        DefaultAuthorizer(),
        TestPlanStore(projects, resolver),
        engine,
        resolver,
        SimpleNamespace(list_tasks=lambda _q: []),
    )


async def add_plan(app: TestingApplication, plan_id: str, name: str, *steps: Any) -> None:
    regions = {"prepare": [], "test": list(steps), "cleanup": []}
    await app.create_plan(
        HUMAN, {"requestId": f"create-{plan_id}", "id": plan_id, "name": name, "regions": regions}
    )


async def run_plan(app: TestingApplication, plan_id: str, request_id: str) -> dict[str, Any]:
    validation = app.validate_plan(HUMAN, plan_id)
    snapshot = await app.start_run(
        HUMAN,
        {
            "planId": plan_id,
            "revision": validation["revision"],
            "executionRevision": validation["executionRevision"],
            "requestId": request_id,
            "parameters": {},
        },
    )
    return await finish(app.engine, snapshot)


async def run_batch(
    app: TestingApplication, request_id: str, *plan_ids: str, **input: Any
) -> dict[str, Any]:
    started = await app.start_batch(
        HUMAN, {"requestId": request_id, "planIds": list(plan_ids), **input}
    )
    return await app.wait_for_batch(HUMAN, started["batchId"], 10_000)


def statuses(app: TestingApplication) -> dict[str, dict[str, Any]]:
    return {item["planId"]: item for item in app.list_item_status(HUMAN)["items"]}


async def test_item_status_tracks_latest_run_per_unit_and_staleness(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    await add_plan(app, "power", "Power", PASS)
    await add_plan(app, "comms", "Comms", FAIL)

    untested = statuses(app)
    assert untested["power"]["stale"] is False
    assert "verdict" not in untested["power"]

    run = await run_plan(app, "power", "run-1")
    assert run["unitId"] == app.current_unit(HUMAN)["unitId"]
    item = statuses(app)["power"]
    assert item["verdict"] == "Pass"
    assert item["runId"] == run["runId"]
    assert item["durationMs"] >= 0

    plan = app.load_plan(HUMAN, "power")
    plan["description"] = "changed"
    await app.save_plan(HUMAN, plan, plan["revision"])
    assert statuses(app)["power"]["stale"] is True


async def test_items_follow_saved_order_then_name(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    for plan_id, name in [("c", "Charlie"), ("a", "Alpha"), ("b", "Bravo")]:
        await add_plan(app, plan_id, name, PASS)
    assert [item["planId"] for item in app.list_item_status(HUMAN)["items"]] == ["a", "b", "c"]
    reordered = app.reorder_items(HUMAN, {"planIds": ["c", "c", "b"]})
    assert [item["planId"] for item in reordered["items"]] == ["c", "b", "a"]
    with pytest.raises(AppError):
        app.reorder_items(HUMAN, {"planIds": "c"})


async def test_batch_runs_items_in_order_and_continues_after_fail(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    events: list[dict[str, Any]] = []
    app.set_batch_notifier(events.append)
    await add_plan(app, "one", "One", FAIL)
    await add_plan(app, "two", "Two", PASS)

    batch = await run_batch(app, "batch-1", "one", "two")
    assert batch["state"] == "completed"
    assert [(item["planId"], item["verdict"]) for item in batch["items"]] == [
        ("one", "Fail"),
        ("two", "Pass"),
    ]
    assert "stopReason" not in batch
    runs = [app.get_run(HUMAN, item["runId"]) for item in batch["items"]]
    assert {run["batchId"] for run in runs} == {batch["batchId"]}
    assert statuses(app)["one"]["verdict"] == "Fail"
    assert any(event.get("kind") == "batch" for event in events)
    assert app.current_batch(HUMAN) == batch
    assert app.get_batch(HUMAN, batch["batchId"]) == batch


async def test_stop_on_fail_skips_remaining_items(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    await add_plan(app, "one", "One", FAIL)
    await add_plan(app, "two", "Two", PASS)
    batch = await run_batch(app, "batch-stop", "one", "two", stopOnFail=True)
    assert batch["state"] == "completed"
    assert batch["stopReason"] == "One: Fail"
    assert [item["state"] for item in batch["items"]] == ["done", "skipped"]


async def test_error_always_stops_the_batch(tmp_path: Path) -> None:
    resolver = Resolver({"type": "object", "required": ["measurement"]})
    app = make_app(tmp_path, resolver)
    invoke = {
        "id": "invoke",
        "type": "InvokeTool",
        "hardwareId": "dev",
        "toolName": "read",
        "arguments": {"output": {"wrong": 1}},
        "timeoutMs": 1000,
        "bindingRevision": resolver.resolve("dev", "read")[0]["bindingRevision"],
    }
    await add_plan(app, "broken", "Broken", invoke)
    await add_plan(app, "after", "After", PASS)
    batch = await run_batch(app, "batch-error", "broken", "after")
    assert batch["items"][0]["verdict"] == "Error"
    assert batch["items"][1]["state"] == "skipped"
    assert batch["stopReason"].startswith("Broken: ")


async def test_abort_batch_stops_current_run_and_skips_the_rest(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    await add_plan(app, "slow", "Slow", SLOW)
    await add_plan(app, "next", "Next", PASS)
    started = await app.start_batch(
        HUMAN, {"requestId": "batch-abort", "planIds": ["slow", "next"]}
    )
    for _ in range(100):
        if app.batches.snapshot()["items"][0].get("runId"):
            break
        await asyncio.sleep(0.01)
    assert statuses(app)["next"]["queued"] is True
    await app.abort_batch(HUMAN, started["batchId"])
    batch = await app.wait_for_batch(HUMAN, started["batchId"], 10_000)
    assert batch["state"] == "aborted"
    assert batch["items"][0]["verdict"] == "Aborted"
    assert batch["items"][1]["state"] == "skipped"


async def test_batch_precheck_rejects_the_whole_batch(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    await add_plan(app, "one", "One", PASS)
    for plan_ids in (["one", "missing"], ["one", "one"], []):
        with pytest.raises(AppError) as failure:
            await app.start_batch(HUMAN, {"requestId": f"bad-{plan_ids}", "planIds": plan_ids})
        assert failure.value.category == "validation_failed"
        assert failure.value.details["issues"]
    assert app.current_batch(HUMAN) is None


async def test_start_batch_is_idempotent(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    await add_plan(app, "one", "One", PASS)
    first = await app.start_batch(HUMAN, {"requestId": "same", "planIds": ["one"]})
    second = await app.start_batch(HUMAN, {"requestId": "same", "planIds": ["one"]})
    assert second["batchId"] == first["batchId"]
    await app.wait_for_batch(HUMAN, first["batchId"], 10_000)


def test_running_batch_becomes_interrupted_after_restart(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    state = RuntimeStateStore(projects)
    state.initialize()
    state.save_batch(
        {
            "batchId": "batch",
            "state": "running",
            "items": [
                {"planId": "a", "planName": "A", "state": "done", "verdict": "Pass"},
                {"planId": "b", "planName": "B", "state": "running"},
                {"planId": "c", "planName": "C", "state": "queued"},
            ],
        }
    )
    restarted = RuntimeStateStore(projects)
    restarted.initialize()
    batch = restarted.latest_batch()
    assert batch is not None
    assert batch["state"] == "interrupted"
    assert batch["completedAt"]
    assert [item["state"] for item in batch["items"]] == ["done", "skipped", "skipped"]
