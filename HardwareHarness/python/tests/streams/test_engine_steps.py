"""Engine + stream recording end to end against the fake SSE service (no hardware)."""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.application import ExecutionCoordinator
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.testing import TestEngine
from hardwareharness_backend.testing.journal import recording_path
from hardwareharness_backend.testing.models import empty_plan

from .fake_service import FakeStreamService

STREAMS = {"ai0": "scalar", "rx": "bytes"}
SAMPLE_MS = 10.0


class Projects:
    def __init__(self, root: Path) -> None:
        self.root = root

    def session(self) -> dict[str, str]:
        return {"projectId": "project", "rootPath": str(self.root)}


class Resolver:
    def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
        semantics = {
            "kind": "actuate",
            "retry": "never",
            "stateRequirements": [],
            "stateEffects": [],
            "evidenceType": "observation",
            "trusted": True,
        }
        return {
            "externalName": f"{hardware_id}__{tool_name}",
            "remoteName": tool_name,
            "deviceId": hardware_id,
            "inputSchema": {"type": "object"},
            "resultSchema": {},
            "annotations": {},
            "operationSemantics": semantics,
        }, []


def plan_with(
    *steps: dict[str, Any], cleanup: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    plan = empty_plan("Plan", "plan")
    plan["regions"]["test"] = list(steps)
    plan["regions"]["cleanup"] = cleanup or []
    return plan


async def finish(engine: TestEngine, snapshot: dict[str, Any]) -> dict[str, Any]:
    run = engine.runs[snapshot["runId"]]
    assert run.task
    await run.task
    return run.snapshot()


class StreamDevices:
    """A DAQ + serial DUT: ``set`` drives the level sampled on ai0, ``send`` answers on rx."""

    def __init__(self, service: FakeStreamService) -> None:
        self.service = service
        self.level = 0.0
        self.levels: list[tuple[float, float]] = [(0.0, 0.0)]
        self.sampler: asyncio.Task[None] | None = None
        self.replies: set[asyncio.Task[None]] = set()

    async def __aenter__(self) -> StreamDevices:
        self.sampler = asyncio.create_task(self._sample())
        return self

    async def __aexit__(self, *_: object) -> None:
        for task in [self.sampler, *self.replies]:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def _sample(self) -> None:
        """Sample ai0 every 10 ms of service time like a buffered DAQ: a stalled event loop
        delays the samples, it does not lose them."""
        due = self.service.now()
        while True:
            now = self.service.now()
            while due <= now:
                level = next(value for t, value in reversed(self.levels) if t <= due)
                self.service.publish("ai0", at=due, v=level)
                due = round(due + SAMPLE_MS, 3)
            await asyncio.sleep(SAMPLE_MS / 1000)

    async def _reply(self, text: str) -> None:
        await asyncio.sleep(0.05)
        self.service.publish("rx", dir="rx", data=text.encode().hex())

    async def list_streams(self, hardware_id: str) -> list[dict[str, Any]]:
        return [{"id": key, "type": kind} for key, kind in STREAMS.items()]

    async def call_aggregated_tool(
        self, name: str, arguments: dict[str, Any], options: dict[str, Any] | None = None
    ) -> Any:
        start = self.service.now()
        if name.endswith("__set"):
            self.level = float(arguments["level"])
            self.levels.append((start, self.level))
        elif name.endswith("__send"):
            task = asyncio.create_task(self._reply(str(arguments["reply"])))
            self.replies.add(task)
        output = {"ok": True}
        if not (options or {}).get("envelope"):
            return output
        return {"data": output, "meta": {"timing": {"start": start, "end": self.service.now()}}}


def invoke(step_id: str, tool: str, anchor: str | None = None, **arguments: Any) -> dict[str, Any]:
    return {
        "id": step_id,
        "type": "InvokeTool",
        "hardwareId": "dev",
        "toolName": tool,
        "arguments": arguments,
        **({"anchor": anchor} if anchor else {}),
    }


def guard(step_id: str, on_violation: str, *children: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": step_id,
        "type": "Guard",
        "hardwareId": "dev",
        "streamId": "ai0",
        "condition": {"op": "lt", "value": 5},
        "onViolation": on_violation,
        "children": list(children),
    }


async def run(tmp_path: Path, plan: dict[str, Any]) -> tuple[TestEngine, dict[str, Any]]:
    async with FakeStreamService(STREAMS, sampled=frozenset({"ai0"})) as service:
        sources = service.sources()
        async with StreamDevices(service) as devices:
            engine = TestEngine(
                Projects(tmp_path),
                devices,
                Resolver(),
                ExecutionCoordinator(),
                stream_sources=sources,
            )
            completed = await finish(engine, await engine.start(plan, {}))
    return engine, completed


def verdicts(engine: TestEngine, run_id: str) -> dict[str, str]:
    return {
        item["sourceStepId"]: item["verdict"]
        for item in engine.runs[run_id].results
        if item.get("kind") == "verdict"
    }


async def test_observe_expect_guard_pass_and_rejudge_consistently(tmp_path: Path) -> None:
    plan = plan_with(
        invoke("drive", "set", "set", level=1.0),
        {
            "id": "level",
            "type": "Observe",
            "hardwareId": "dev",
            "streamId": "ai0",
            "window": {"anchor": "set", "startMs": 20, "endMs": 120},
            "assertions": [{"metric": "mean", "op": "within", "value": [0.9, 1.1]}],
        },
        invoke("ask", "send", "sent", reply="OK"),
        {
            "id": "answer",
            "type": "Expect",
            "hardwareId": "dev",
            "streamId": "rx",
            "anchor": "sent",
            "withinMs": 1000,
            "match": {"pattern": "OK"},
        },
        guard("safe", "fail", {"id": "hold", "type": "Delay", "durationMs": 100}),
    )
    engine, completed = await run(tmp_path, plan)
    assert completed["verdict"] == "Pass", engine.runs[completed["runId"]].results
    assert verdicts(engine, completed["runId"]) == {
        "level": "Pass",
        "answer": "Pass",
        "safe": "Pass",
    }
    run_dir = tmp_path / ".hardwareharness" / "runs" / completed["runId"]
    assert recording_path(run_dir) == run_dir / "run.sqlite"
    assert not (run_dir / "streams.sqlite").exists()
    kinds = {event["type"] for event in engine.runs[completed["runId"]].events}
    assert {"recording.started", "anchor.set"} <= kinds
    rejudged = engine.rejudge_run(completed["runId"])
    assert rejudged["consistent"] is True
    assert {item["sourceStepId"] for item in rejudged["results"]} == {"level", "answer", "safe"}

    run_id = completed["runId"]
    timeline = engine.get_run_timeline(run_id)
    assert {step["stepId"] for step in timeline["steps"]} >= {"drive", "level", "answer"}
    assert {call["stepId"] for call in timeline["calls"]} == {"drive", "ask"}
    windows = {window["stepId"]: window for window in timeline["windows"]}
    assert windows["level"]["verdict"] == "Pass" and windows["level"]["tb0"] is not None
    assert "matchTb" in windows["answer"]
    assert {mark["type"] for mark in timeline["marks"]} >= {"run.started", "recording.started"}

    listed = engine.list_run_streams(run_id)
    keys = {item["streamId"]: item["key"] for item in listed["streams"]}
    assert listed["recording"] is False and set(keys) == {"ai0", "rx"}
    scalar = engine.read_run_stream(run_id, keys["ai0"], {"maxPoints": 100})
    assert scalar["mode"] == "points" and scalar["points"]

    io = engine.read_run_io(run_id)
    streams = {item["streamId"]: item for item in io["streams"]}
    assert streams["ai0"]["summary"]["count"] > 0
    assert any(
        "OK" in bytes.fromhex(record["data"]).decode()
        for record in streams["rx"]["records"]
        if record.get("dir") == "rx"
    )
    level = engine.read_run_io(run_id, "level")
    assert [window["stepId"] for window in level["windows"]] == ["level"]
    assert level["calls"] == [] and level["tb0"] is not None
    with pytest.raises(AppError, match="no step"):
        engine.read_run_io(run_id, "missing")


async def test_guard_abort_stops_children_and_fails_the_run(tmp_path: Path) -> None:
    plan = plan_with(
        guard(
            "safe",
            "abort",
            invoke("overdrive", "set", level=9.0),
            {"id": "long", "type": "Delay", "durationMs": 5000},
        ),
        {"id": "after", "type": "PublishResult", "name": "after", "value": 1},
        cleanup=[{"id": "cleanup", "type": "PublishResult", "name": "cleanup", "value": 1}],
    )
    started = asyncio.get_running_loop().time()
    engine, completed = await run(tmp_path, plan)
    assert asyncio.get_running_loop().time() - started < 4
    assert completed["verdict"] == "Fail"
    assert completed["executionStatus"] == "Aborted"
    names = [item.get("name") for item in engine.runs[completed["runId"]].results]
    assert "after" not in names and "cleanup" in names
    assert verdicts(engine, completed["runId"])["safe"] == "Fail"
    events = engine.runs[completed["runId"]].events
    assert any(event["type"] == "guard.violated" for event in events)


async def test_guard_fail_marks_the_step_and_the_run_continues(tmp_path: Path) -> None:
    plan = plan_with(
        guard(
            "safe",
            "fail",
            invoke("overdrive", "set", level=9.0),
            {"id": "long", "type": "Delay", "durationMs": 5000},
        ),
        {"id": "after", "type": "PublishResult", "name": "after", "value": 1},
    )
    engine, completed = await run(tmp_path, plan)
    assert completed["verdict"] == "Fail"
    assert completed["executionStatus"] == "Succeeded"
    names = [item.get("name") for item in engine.runs[completed["runId"]].results]
    assert "after" in names
    assert verdicts(engine, completed["runId"])["safe"] == "Fail"
