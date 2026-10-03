from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from teststand_backend.application import DefaultAuthorizer, ExecutionCoordinator
from teststand_backend.contracts.errors import AppError
from teststand_backend.testing import TestEngine, TestingApplication, TestPlanStore
from teststand_backend.testing.validation import validate_plan

from .test_testing import Devices, Projects, Resolver, finish, plan_with

AGENT = {"actor": "agent", "source": "mcp"}
HUMAN = {"actor": "human", "source": "desktop"}
CHECK = {
    "id": "look",
    "type": "ManualCheck",
    "prompt": "屏幕是否显示彩条？",
    "requireNote": True,
    "requirementIds": ["R1"],
}


async def waiting(engine: TestEngine, run_id: str) -> dict[str, Any]:
    for _ in range(200):
        checks = engine.runs[run_id].snapshot()["manualChecks"]
        if checks:
            return dict(checks[0])
        await asyncio.sleep(0.01)
    raise AssertionError("The manual check never started waiting")


def engine_for(tmp_path: Path) -> TestEngine:
    return TestEngine(Projects(tmp_path), Devices(), Resolver(), ExecutionCoordinator())


async def test_manual_check_waits_for_the_operator_and_publishes_m_evidence(
    tmp_path: Path,
) -> None:
    engine = engine_for(tmp_path)
    plan = plan_with(CHECK)
    plan["requirements"] = [{"id": "R1", "name": "彩条"}]
    started = await engine.start(plan, {})
    request = await waiting(engine, started["runId"])
    assert request["prompt"] == "屏幕是否显示彩条？"
    assert [option["label"] for option in request["options"]] == ["通过", "不通过", "无法判断"]

    with pytest.raises(AppError, match="requires a note"):
        engine.answer_manual_check(started["runId"], request["executionId"], "通过", " ", "张工")
    with pytest.raises(AppError, match="Unknown option"):
        engine.answer_manual_check(started["runId"], request["executionId"], "好", "ok", "张工")
    engine.answer_manual_check(started["runId"], request["executionId"], "不通过", "无彩条", "张工")
    completed = await finish(engine, started)

    assert completed["verdict"] == "Fail"
    assert completed["manualChecks"] == []
    assert completed["coverage"]["requirements"][0]["status"] == "Failed"
    run = engine.runs[started["runId"]]
    verdict = next(result for result in run.results if result.get("kind") == "verdict")
    assert verdict["evidenceType"] == "M"
    assert verdict["evidence"]["operator"] == "张工"
    assert verdict["evidence"]["note"] == "无彩条"
    assert run.outputs["look"]["verdict"] == "fail"
    types = [event["type"] for event in run.events]
    assert types.index("manual.requested") < types.index("manual.answered")
    with pytest.raises(AppError, match="no longer waiting"):
        engine.answer_manual_check(started["runId"], request["executionId"], "通过", "x", "张工")


async def test_manual_check_timeout_is_operator_undecided(tmp_path: Path) -> None:
    engine = engine_for(tmp_path)
    step = {"id": "look", "type": "ManualCheck", "prompt": "看一眼", "timeoutMs": 30}
    completed = await finish(engine, await engine.start(plan_with(step), {}))
    assert completed["verdict"] == "Inconclusive"
    run = engine.runs[completed["runId"]]
    verdict = next(result for result in run.results if result.get("kind") == "verdict")
    assert verdict["evidence"]["reason"] == "operator_undecided"
    assert verdict["evidence"]["timedOut"] is True


async def test_abort_releases_a_waiting_manual_check(tmp_path: Path) -> None:
    engine = engine_for(tmp_path)
    started = await engine.start(
        plan_with({"id": "look", "type": "ManualCheck", "prompt": "?"}), {}
    )
    await waiting(engine, started["runId"])
    await engine.abort(started["runId"])
    aborted = await finish(engine, started)
    assert aborted["verdict"] == "Aborted"
    assert aborted["manualChecks"] == []


def test_manual_check_validation() -> None:
    bad = plan_with(
        {
            "id": "look",
            "type": "ManualCheck",
            "prompt": "",
            "timeoutMs": 0,
            "options": [
                {"label": "好", "verdict": "pass"},
                {"label": "好", "verdict": "maybe"},
            ],
        }
    )
    issues = {(item["code"], item["path"]) for item in validate_plan(bad)}
    base = "/regions/test/0"
    assert ("manual.prompt", base + "/prompt") in issues
    assert ("manual.timeout", base + "/timeoutMs") in issues
    assert ("manual.option", base + "/options/1/label") in issues
    assert ("manual.option", base + "/options/1/verdict") in issues
    assert not validate_plan(plan_with(CHECK))


async def test_only_a_person_may_answer_a_manual_check(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    engine = TestEngine(projects, Devices(), Resolver(), ExecutionCoordinator())
    wiring = SimpleNamespace(list_tasks=lambda _query: [])
    app = TestingApplication(
        DefaultAuthorizer(), TestPlanStore(projects, None), engine, Resolver(), wiring
    )
    started = await engine.start(
        plan_with({"id": "look", "type": "ManualCheck", "prompt": "?"}), {}
    )
    request = await waiting(engine, started["runId"])
    answer = {"runId": started["runId"], "executionId": request["executionId"], "option": "通过"}
    with pytest.raises(AppError, match="testing.judge"):
        app.answer_manual_check(AGENT, answer)
    snapshot = app.answer_manual_check(HUMAN, answer)
    assert snapshot["runId"] == started["runId"]
    completed = await finish(engine, started)
    assert completed["verdict"] == "Pass"
    verdict = next(r for r in engine.runs[started["runId"]].results if r.get("kind") == "verdict")
    assert verdict["evidence"]["operator"]
