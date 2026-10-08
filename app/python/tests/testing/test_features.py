from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from teststand_backend.application import DefaultAuthorizer, ExecutionCoordinator
from teststand_backend.contracts.errors import AppError
from teststand_backend.testing import TestEngine, TestingApplication, TestPlanStore
from teststand_backend.testing.compiler import compile_plan
from teststand_backend.testing.validation import validate_plan

from .test_testing import HUMAN, Devices, Projects, Resolver, finish, plan_with


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


def feature(step_id: str, *children: dict[str, Any]) -> dict[str, Any]:
    return {"id": step_id, "type": "Feature", "name": step_id.title(), "children": list(children)}


def publish(step_id: str, verdict: str) -> dict[str, Any]:
    return {"id": step_id, "type": "PublishResult", "value": 1, "verdict": verdict}


async def edit_flow(app: TestingApplication, *steps: dict[str, Any]) -> None:
    flow = app.load_plan(HUMAN)
    operations = [{"type": "insert_step", "region": "test", "step": step} for step in steps]
    await app.apply_plan_operations(
        HUMAN,
        {"baseRevision": flow["revision"], "requestId": "edit", "operations": operations},
    )


async def run_flow(app: TestingApplication, request_id: str, **input: Any) -> dict[str, Any]:
    validation = app.validate_plan(HUMAN)
    snapshot = await app.start_run(
        HUMAN,
        {
            "revision": validation["revision"],
            "executionRevision": validation["executionRevision"],
            "requestId": request_id,
            **input,
        },
    )
    return await finish(app.engine, snapshot)


async def test_unselected_groups_are_skipped_and_leave_the_verdict(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    await edit_flow(
        app, feature("power", publish("ok", "Pass")), feature("comm", publish("bad", "Fail"))
    )

    run = await run_flow(app, "run-power", features=["power"])
    assert run["verdict"] == "Pass"
    assert run["features"] == ["power"]
    events = app.read_run_log(HUMAN, run["runId"])["events"]
    skipped = [item for item in events if item["type"] == "step.skipped"]
    assert [(item["stepId"], item["reason"]) for item in skipped] == [("comm", "notSelected")]

    everything = await run_flow(app, "run-all")
    assert everything["verdict"] == "Fail"
    assert everything["features"] == ["power", "comm"]
    # The selection keeps flow order, whatever order the request names the groups in.
    reordered = await run_flow(app, "run-both", features=["comm", "power"])
    assert reordered["features"] == ["power", "comm"]


async def test_start_rejects_what_is_not_a_feature_group(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    await edit_flow(app, feature("power", publish("ok", "Pass")))
    for selected in (["ok"], ["nope"], "power", [1]):
        with pytest.raises(AppError) as failure:
            await run_flow(app, f"run-{selected}", features=selected)
        assert failure.value.category == "invalid_argument"


def test_a_group_does_not_see_what_the_one_before_it_set_up() -> None:
    plan = plan_with(
        {"id": "base", "type": "Evaluate", "expression": "1"},
        feature("first", {"id": "made", "type": "Evaluate", "expression": "2"}),
        feature(
            "second",
            {"id": "seen", "type": "PublishResult", "valueExpression": "steps.base.output.value"},
            {"id": "leak", "type": "PublishResult", "valueExpression": "steps.made.output.value"},
        ),
    )
    compiled = compile_plan(plan, Resolver())
    paths = {item["path"] for item in compiled["issues"] if item["severity"] == "error"}
    assert any(path.startswith("/regions/test/2/children/1") for path in paths)
    assert not any(path.startswith("/regions/test/2/children/0") for path in paths)


def test_feature_groups_sit_at_the_top_of_the_test_region() -> None:
    nested = feature("inner")
    plan = plan_with(feature("outer", nested), {"id": "group", "type": "Group", "children": []})
    plan["regions"]["prepare"] = [feature("early")]
    paths = {item["path"] for item in validate_plan(plan) if item["code"] == "feature.placement"}
    assert paths == {"/regions/test/0/children/0", "/regions/prepare/0"}


async def test_saved_plans_become_feature_groups_of_the_flow(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    store = app.store
    await store.create(
        {
            "id": "power",
            "name": "Power",
            "parameters": [{"name": "station", "type": "integer", "default": 1}],
            "regions": {
                "prepare": [{"id": "setup", "type": "Delay", "durationMs": 0}],
                "test": [publish("check", "Pass")],
                "cleanup": [{"id": "off", "type": "Delay", "durationMs": 0}],
            },
        }
    )
    await store.create(
        {
            "id": "2comm",
            "name": "Comm",
            "parameters": [{"name": "station", "type": "integer", "default": 2}],
            "bindings": {"uart": {"hardwareId": "PC1.CARD"}},
            "regions": {"prepare": [], "test": [publish("check", "Fail")], "cleanup": []},
        }
    )
    flow = app.load_plan(HUMAN)
    assert flow["id"] == "flow"
    groups = flow["regions"]["test"]
    assert [(item["id"], item["name"]) for item in groups] == [
        ("f_2comm", "Comm"),
        ("power", "Power"),
    ]
    assert [step["id"] for step in groups[0]["children"]] == ["check"]
    assert [step["id"] for step in groups[1]["children"]] == ["setup", "check_2"]
    assert [step["id"] for step in flow["regions"]["cleanup"]] == ["off"]
    assert flow["parameters"] == [{"name": "station", "type": "integer", "default": 2}]
    assert flow["bindings"] == {"uart": {"hardwareId": "PC1.CARD"}}
    plans = tmp_path / ".teststand" / "plans"
    assert sorted(path.name for path in plans.glob("*.hhplan.yaml")) == ["flow.hhplan.yaml"]
    assert sorted(path.name for path in (plans / ".migrated").iterdir()) == [
        "2comm.hhplan.yaml",
        "power.hhplan.yaml",
    ]
    # The flow is made once; reading it again changes nothing.
    assert app.load_plan(HUMAN) == flow
