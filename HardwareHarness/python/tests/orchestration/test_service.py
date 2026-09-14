from __future__ import annotations

import asyncio
import copy
from collections.abc import Callable
from typing import Any
from unittest.mock import AsyncMock

import pytest

from hardwareharness_backend.application import ExecutionCoordinator, ExecutionLease
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.orchestration import TaskOrchestrationService

Json = dict[str, Any]
TOOL: Json = {
    "externalName": "SERVER1__measure",
    "remoteName": "measure",
    "serverId": "SERVER1",
    "description": "Fixture measurement",
    "inputSchema": {
        "type": "object",
        "properties": {"hardwareId": {"type": "string"}, "value": {"type": "number"}},
        "required": ["hardwareId", "value"],
    },
    "kind": "hardware",
}


def task(name: str = "Voltage test") -> Json:
    return {
        "formatVersion": 2,
        "taskId": "TASK1",
        "name": name,
        "inputs": [{"name": "payload", "type": "string", "defaultValue": "default"}],
        "variables": [],
        "setup": [],
        "steps": [
            {
                "stepId": "STEP1",
                "label": "Measure",
                "enabled": True,
                "type": "tool",
                "toolName": TOOL["externalName"],
                "hardwareId": "HW1",
                "arguments": {"value": {"kind": "literal", "value": 3.3}},
                "outputBindings": [],
                "timeoutMs": 30000,
                "idempotent": False,
                "retry": {
                    "maxAttempts": 1,
                    "delayMs": 0,
                    "backoff": "fixed",
                    "retryOn": ["unavailable"],
                },
            }
        ],
        "cleanup": [],
    }


class MemoryLogs:
    def __init__(self) -> None:
        self.archives: dict[str, Json] = {}
        self.snapshots: dict[str, Json] = {}
        self.warnings: list[str] = []
        self.removed: list[tuple[str, str]] = []

    async def load(self, root_path: str) -> Json:
        return copy.deepcopy(
            {
                "archives": list(self.archives.values()),
                "snapshots": list(self.snapshots.values()),
                "warnings": self.warnings,
            }
        )

    async def upsert_run(self, root_path: str, run: Json) -> None:
        current = self.archives.setdefault(
            run["runId"], {"formatVersion": 1, "nodeRuns": [], "events": []}
        )
        current["run"] = copy.deepcopy(run)

    async def upsert_node_run(self, root_path: str, node: Json) -> None:
        current = self.archives[node["runId"]]["nodeRuns"]
        for index, existing in enumerate(current):
            if existing["nodeRunId"] == node["nodeRunId"]:
                current[index] = copy.deepcopy(node)
                return
        current.append(copy.deepcopy(node))

    async def append_events(self, root_path: str, run_id: str, events: list[Json]) -> None:
        current = self.archives[run_id]
        by_id = {event["eventId"]: event for event in current["events"]}
        by_id.update({event["eventId"]: copy.deepcopy(event) for event in events})
        current["events"] = sorted(by_id.values(), key=lambda event: event["eventId"])

    async def upsert_execution_snapshot(self, root_path: str, snapshot: Json) -> None:
        self.snapshots[snapshot["runId"]] = copy.deepcopy(snapshot)

    async def remove(self, root_path: str, run_id: str) -> None:
        self.removed.append((root_path, run_id))
        self.archives.pop(run_id, None)
        self.snapshots.pop(run_id, None)

    async def clear(self, root_path: str, run_ids: list[str]) -> None:
        for run_id in run_ids:
            await self.remove(root_path, run_id)


class MemoryExecution(ExecutionCoordinator):
    def __init__(self) -> None:
        super().__init__()
        self.releases = 0

    def acquire(self, activity: Json) -> ExecutionLease:
        underlying = super().acquire(activity)

        def release() -> None:
            self.releases += 1
            underlying.release()

        return ExecutionLease(release)


class Projects:
    def __init__(self, value: Json, canvas: bool) -> None:
        self.value = value
        self.canvas = canvas

    def task(self) -> Json:
        return copy.deepcopy(self.value)

    def wiring(self) -> Json:
        return {
            "nodes": [{"hardwareId": "HW1", "x": 0, "y": 0, "showImage": True, "portPositions": {}}]
            if self.canvas
            else [],
            "connections": [],
        }

    def update_task(self, value: Json) -> Json:
        self.value = copy.deepcopy(value)
        return {"dirty": True, "file": {"task": value}}

    def project_id(self) -> str:
        return "PROJECT1"

    def session(self) -> Json:
        return {"projectId": "PROJECT1", "rootPath": "C:\\project"}


class Tools:
    def __init__(self, occupied: bool, call: AsyncMock | None) -> None:
        self.occupied = occupied
        self.call_tool = call or AsyncMock(return_value={"value": 3.3})

    def list_tools(self) -> list[Json]:
        return [TOOL]

    def is_hardware_occupied(self, hardware_id: str) -> bool:
        return self.occupied


class Catalog:
    def get_hardware(self, hardware_id: str) -> Json:
        return {
            "formatVersion": 2,
            "hardwareId": "HW1",
            "label": "HW1",
            "kind": "managed",
            "serverId": "SERVER1",
            "computerId": "PC1",
            "ports": [],
        }


def fixture(
    *,
    value: Json | None = None,
    logs: MemoryLogs | None = None,
    execution: ExecutionCoordinator | None = None,
    call: AsyncMock | None = None,
    canvas: bool = True,
    occupied: bool = True,
    safety: Json | None = None,
) -> tuple[TaskOrchestrationService, MemoryLogs, ExecutionCoordinator, Projects, Tools]:
    project = Projects(value or task(), canvas)
    history = logs or MemoryLogs()
    coordinator = execution or MemoryExecution()
    tools = Tools(occupied, call)
    service = TaskOrchestrationService(project, tools, Catalog(), coordinator, history, safety)
    return service, history, coordinator, project, tools


async def eventually(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.002)


def archive(run_id: str, status: str, created: str, name: str) -> Json:
    run: Json = {
        "runId": run_id,
        "taskId": "TASK1",
        "taskName": name,
        "projectId": "PROJECT1",
        "status": status,
        "inputs": {},
        "createdAt": created,
    }
    if status == "running":
        run["startedAt"] = created
    else:
        run.update(
            completedAt=created,
            summary={
                "passedNodes": int(status == "passed"),
                "failedNodes": int(status == "failed"),
                "cancelledNodes": 0,
            },
        )
    return {
        "formatVersion": 1,
        "run": run,
        "nodeRuns": [],
        "events": [
            {
                "eventId": int("".join(c for c in run_id if c.isdigit()) or "1"),
                "runId": run_id,
                "timestamp": created,
                "type": f"run.{status}",
            }
        ],
    }


async def never(*args: Any, **kwargs: Any) -> Any:
    await asyncio.Future()


def category_error(category: str, message: str) -> Exception:
    return app_error(category, message)


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::persists "
    "completed Runs with task-name snapshots and UTF-8 bounded values, then "
    "reloads them"
)
async def test_persistence_bounds_reload() -> None:
    huge = "测" * 40000
    service, logs, _, project, _ = fixture(call=AsyncMock(return_value={"payload": huge}))
    await service.initialize()
    started = await service.start_run({"inputs": {"payload": huge}})
    run_id = started["run"]["runId"]
    await eventually(lambda: service.get_run(run_id)["run"]["status"] == "passed")
    project.value = task("Renamed later")
    await service.close()
    saved = logs.archives[run_id]
    assert saved["run"]["taskName"] == "Voltage test"
    for bounded in [saved["run"]["inputs"], saved["nodeRuns"][0]["output"]]:
        assert bounded["truncated"] is True
        assert isinstance(bounded["bytes"], int)
        assert isinstance(bounded["preview"], str)
    assert saved["run"]["inputs"]["bytes"] > 100000
    second, *_ = fixture(logs=logs, value=task("Renamed later"))
    await second.initialize()
    assert second.list_runs()["items"][0]["taskName"] == "Voltage test"
    assert second.list_runs()["items"][0]["runId"] == run_id
    assert second.list_runs()["items"][0]["status"] == "passed"
    assert second.export_run(run_id) == saved
    await second.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::marks a "
    "persisted active Run interrupted and appends a recovery event"
)
async def test_recovery_without_snapshot() -> None:
    logs = MemoryLogs()
    logs.archives["RUN9"] = archive("RUN9", "running", "2026-08-14T09:00:00.000Z", "Recovered task")
    service, *_ = fixture(logs=logs)
    await service.initialize()
    detail = service.get_run("RUN9")
    assert detail["run"]["status"] == "interrupted"
    assert "completedAt" in detail["run"]
    assert detail["events"][-1]["type"] == "run.interrupted"
    assert detail["events"][-1]["data"]["reason"] == "application_restart"
    assert logs.archives["RUN9"]["run"]["status"] == "interrupted"
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::filters, "
    "pages, exports, deletes and clears project-isolated history"
)
async def test_history_query() -> None:
    logs = MemoryLogs()
    logs.warnings = ["broken.json: invalid JSON"]
    for run_id, status, date, name in [
        ("RUN1", "passed", "10", "Alpha"),
        ("RUN2", "failed", "12", "Beta"),
        ("RUN3", "blocked", "13", "Alpha retry"),
        ("FOREIGN", "passed", "14", "Foreign"),
    ]:
        logs.archives[run_id] = archive(run_id, status, f"2026-08-{date}T10:00:00.000Z", name)
    logs.archives["FOREIGN"]["run"]["projectId"] = "OTHER"
    service, *_ = fixture(logs=logs)
    await service.initialize()
    assert service.list_runs({"search": "alpha"})["total"] == 2
    assert [r["runId"] for r in service.list_runs({"statuses": ["failed"]})["items"]] == ["RUN2"]
    assert (
        service.list_runs({"from": "2026-08-12T00:00:00.000Z", "to": "2026-08-13T23:59:59.999Z"})[
            "total"
        ]
        == 2
    )
    assert service.list_runs({"offset": 1, "limit": 1})["items"][0]["runId"] == "RUN2"
    assert [r["runId"] for r in service.list_runs({"taskName": "Alpha"})["items"]] == ["RUN1"]
    assert service.list_runs()["taskNames"] == ["Alpha", "Alpha retry", "Beta"]
    assert [
        r["taskName"] for r in service.list_runs({"sortBy": "taskName", "sortDir": "asc"})["items"]
    ] == ["Alpha", "Alpha retry", "Beta"]
    assert [
        r["status"] for r in service.list_runs({"sortBy": "status", "sortDir": "asc"})["items"]
    ] == ["blocked", "failed", "passed"]
    assert "broken.json: invalid JSON" in service.list_runs()["warnings"]
    assert any("projectId" in warning for warning in service.list_runs()["warnings"])
    assert service.export_run("RUN1")["run"]["taskName"] == "Alpha"
    await service.delete_run("RUN1")
    assert logs.removed == [("C:\\project", "RUN1")]
    with pytest.raises(Exception, match="Unknown runId"):
        service.get_run("RUN1")
    assert await service.clear_completed_runs() == {"deleted": 2}
    assert service.list_runs()["total"] == 0
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::waits for "
    "pending persistence before deleting so a background save cannot recreate "
    "the file"
)
async def test_delete_flushes(monkeypatch: pytest.MonkeyPatch) -> None:
    gate = asyncio.Event()
    logs = MemoryLogs()
    original = logs.upsert_run

    async def blocked_save(root: str, run: Json) -> None:
        await gate.wait()
        await original(root, run)

    monkeypatch.setattr(logs, "upsert_run", blocked_save)
    service, *_ = fixture(logs=logs, canvas=False)
    await service.initialize()
    started = await service.start_run()
    deletion = asyncio.create_task(service.delete_run(started["run"]["runId"]))
    await asyncio.sleep(0)
    assert logs.removed == []
    gate.set()
    await deletion
    assert len(logs.removed) == 1
    assert started["run"]["runId"] not in logs.archives
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::uses event "
    "ids that are monotonic within each Run instead of globally"
)
async def test_per_run_event_ids() -> None:
    service, logs, *_ = fixture(canvas=False)
    await service.initialize()
    first = await service.start_run()
    second = await service.start_run()
    await service.close()
    for detail in [first, second]:
        assert [event["eventId"] for event in detail["events"]] == [1]
        assert [event["eventId"] for event in logs.archives[detail["run"]["runId"]]["events"]] == [
            1
        ]


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::requeues a "
    "failed incremental write with backoff instead of silently losing it"
)
async def test_retry_persistence(monkeypatch: pytest.MonkeyPatch) -> None:
    logs = MemoryLogs()
    calls = 0
    original = logs.upsert_run

    async def flaky(root: str, run: Json) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("temporary disk failure")
        await original(root, run)

    monkeypatch.setattr(logs, "upsert_run", flaky)
    service, *_ = fixture(logs=logs, canvas=False)
    await service.initialize()
    detail = await service.start_run()
    await service.close()
    assert calls == 2
    assert logs.archives[detail["run"]["runId"]] == service.export_run(detail["run"]["runId"])
    assert any("retrying" in warning for warning in service.list_runs()["warnings"])


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::blocks Run "
    "preflight when referenced hardware is not occupied"
)
async def test_preflight_occupancy() -> None:
    service, *_ = fixture(occupied=False)
    await service.initialize()
    detail = await service.start_run()
    assert detail["run"]["status"] == "blocked"
    assert "hardware_not_occupied" in str(detail["events"])
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::records a "
    "blocked preflight without attempting a hardware lease"
)
async def test_blocked_without_lease() -> None:
    service, logs, execution, *_ = fixture(canvas=False)
    lease = execution.acquire(
        {
            "state": "manual",
            "hardwareId": "HW1",
            "toolName": "write",
            "startedAt": "2026-01-01T00:00:00.000Z",
        }
    )
    await service.initialize()
    detail = await service.start_run()
    assert detail["run"]["status"] == "blocked"
    assert execution.current()["state"] == "manual"
    assert len(logs.archives) == 1
    lease.release()
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::rejects a "
    "valid Run when a manual call holds required hardware"
)
async def test_manual_blocks_valid_run() -> None:
    service, logs, execution, *_ = fixture()
    lease = execution.acquire(
        {
            "state": "manual",
            "hardwareId": "HW1",
            "toolName": "write",
            "startedAt": "2026-01-01T00:00:00.000Z",
        }
    )
    await service.initialize()
    with pytest.raises(Exception) as caught:
        await service.start_run()
    assert getattr(caught.value, "category", None) == "conflict"
    assert not logs.archives
    lease.release()
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::holds the "
    "Run lease until cancellation completes and releases it afterward"
)
async def test_cancel_releases_lease() -> None:
    service, _, execution, *_ = fixture(call=AsyncMock(side_effect=never))
    await service.initialize()
    detail = await service.start_run()
    assert execution.current()["state"] == "run"
    with pytest.raises(Exception) as caught:
        await service.start_run()
    assert getattr(caught.value, "category", None) == "conflict"
    await service.cancel_run(detail["run"]["runId"])
    await eventually(
        lambda: service.get_run(detail["run"]["runId"])["run"]["status"] == "cancelled"
    )
    assert execution.current()["state"] == "idle"
    assert getattr(execution, "releases", None) == 1
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::marks an "
    "active Run interrupted and releases its lease during close"
)
async def test_close_interrupts() -> None:
    service, _, execution, *_ = fixture(call=AsyncMock(side_effect=never))
    await service.initialize()
    detail = await service.start_run()
    await service.close()
    assert service.get_run(detail["run"]["runId"])["run"]["status"] == "interrupted"
    assert execution.current()["state"] == "idle"
    assert getattr(execution, "releases", None) == 1


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::rejects a "
    "queued start while close waits for start operations"
)
async def test_queued_start_during_close() -> None:
    service, _, execution, *_ = fixture(call=AsyncMock(side_effect=never))
    await service.initialize()
    detail = await service.start_run()
    queued = asyncio.create_task(service.start_run())
    closing = asyncio.create_task(service.close())
    with pytest.raises(Exception) as caught:
        await queued
    assert getattr(caught.value, "category", None) == "conflict"
    await closing
    assert service.get_run(detail["run"]["runId"])["run"]["status"] == "interrupted"
    assert len(service.list_runs()["items"]) == 1
    assert execution.current()["state"] == "idle"


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::times out an "
    "operator step in cleanup instead of waiting forever"
)
async def test_cleanup_operator_timeout() -> None:
    value = task()
    value["steps"] = []
    value["cleanup"] = [
        {
            "stepId": "CLEANUP-OP",
            "label": "Confirm safe state",
            "enabled": True,
            "type": "operator",
            "prompt": "Confirm safe state",
            "options": [{"label": "Done", "value": "done"}],
        }
    ]
    service, *_ = fixture(
        value=value, safety={"cleanupBudgetMs": 200, "cleanupOperatorTimeoutMs": 20}
    )
    await service.initialize()
    detail = await service.start_run()
    await eventually(lambda: service.get_run(detail["run"]["runId"])["run"]["status"] == "failed")
    node = service.get_run(detail["run"]["runId"])["nodeRuns"][-1]
    assert (node["nodeId"], node["status"], node["error"]["category"]) == (
        "CLEANUP-OP",
        "failed",
        "unavailable",
    )
    assert service.list_operator_decisions() == []
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::returns from "
    "close within the cleanup budget even when a remote call ignores abort"
)
async def test_cleanup_budget() -> None:
    value = task()
    value["cleanup"] = [{**value["steps"][0], "stepId": "CLEANUP", "label": "Safe stop"}]
    call = AsyncMock(side_effect=never)
    service, _, execution, *_ = fixture(
        value=value, call=call, safety={"cleanupBudgetMs": 40, "cleanupOperatorTimeoutMs": 20}
    )
    await service.initialize()
    detail = await service.start_run()
    await eventually(lambda: call.call_count == 1)
    await asyncio.wait_for(service.close(), 0.5)
    assert call.call_count == 2
    assert service.get_run(detail["run"]["runId"])["run"]["status"] == "interrupted"
    assert execution.current()["state"] == "idle"


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::never "
    "retries a non-idempotent tool step"
)
async def test_non_idempotent_no_retry() -> None:
    value = task()
    value["steps"][0]["retry"]["maxAttempts"] = 3
    call = AsyncMock(side_effect=category_error("unavailable", "offline"))
    service, *_ = fixture(value=value, call=call)
    await service.initialize()
    detail = await service.start_run()
    await eventually(lambda: service.get_run(detail["run"]["runId"])["run"]["status"] == "failed")
    assert call.call_count == 1
    assert len(service.get_run(detail["run"]["runId"])["nodeRuns"][0]["attemptErrors"]) == 1
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::retries only "
    "selected categories and sends stable idempotency metadata"
)
async def test_idempotent_retry() -> None:
    value = task()
    value["steps"][0].update(
        idempotent=True,
        retry={
            "maxAttempts": 3,
            "delayMs": 0,
            "backoff": "exponential",
            "retryOn": ["unavailable"],
        },
    )
    call = AsyncMock(side_effect=[category_error("unavailable", "warming up"), {"value": 3.3}])
    service, *_ = fixture(value=value, call=call)
    await service.initialize()
    detail = await service.start_run()
    await eventually(lambda: service.get_run(detail["run"]["runId"])["run"]["status"] == "passed")
    assert call.call_count == 2
    first, second = [entry.args for entry in call.call_args_list]
    assert first[1] == {"value": 3.3}
    assert first[2]["metadata"]["hardwareId"] == "HW1"
    assert first[2]["metadata"]["attempt"] == 1
    assert isinstance(first[2]["metadata"]["idempotencyKey"], str)
    assert second[2]["metadata"] == {**first[2]["metadata"], "attempt": 2}
    errors = service.get_run(detail["run"]["runId"])["nodeRuns"][0]["attemptErrors"]
    assert len(errors) == 1
    assert {key: errors[0][key] for key in ["attempt", "category", "message"]} == {
        "attempt": 1,
        "category": "unavailable",
        "message": "warming up",
    }
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::serializes "
    "parallel branches that target the same hardware"
)
async def test_parallel_serializes_hardware() -> None:
    value = task()
    base = value["steps"][0]
    value["steps"] = [
        {
            "stepId": "PARALLEL",
            "label": "Parallel",
            "enabled": True,
            "type": "parallel",
            "branches": [
                {
                    "branchId": name,
                    "name": name,
                    "steps": [{**base, "stepId": f"{name}-TOOL", "label": name}],
                }
                for name in ["A", "B"]
            ],
        }
    ]
    active = maximum = 0

    async def measure(*args: Any) -> Json:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02)
        active -= 1
        return {"value": 3.3}

    call = AsyncMock(side_effect=measure)
    service, *_ = fixture(value=value, call=call)
    await service.initialize()
    detail = await service.start_run()
    await eventually(lambda: service.get_run(detail["run"]["runId"])["run"]["status"] == "passed")
    assert call.call_count == 2
    assert maximum == 1
    await service.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::runs "
    "compensating cleanup after a crash leaves a non-idempotent tool uncertain"
)
async def test_non_idempotent_recovery() -> None:
    value = task()
    value["steps"][0]["arguments"] = {"value": {"kind": "literal", "value": 1}}
    value["cleanup"] = [
        {
            **value["steps"][0],
            "stepId": "CLEAN",
            "label": "Safe voltage",
            "arguments": {"value": {"kind": "literal", "value": 0}},
        }
    ]
    call = AsyncMock(side_effect=never)
    first, logs, *_ = fixture(value=value, call=call, safety={"cleanupBudgetMs": 40})
    await first.initialize()
    detail = await first.start_run()
    run_id = detail["run"]["runId"]
    await eventually(lambda: run_id in logs.snapshots and bool(logs.archives[run_id]["nodeRuns"]))
    recovered = AsyncMock(return_value={"accepted": True})
    second, *_ = fixture(value=value, logs=copy.deepcopy(logs), call=recovered)
    await second.initialize()
    await eventually(lambda: second.get_run(run_id)["run"]["status"] == "interrupted")
    assert [entry.args[1]["value"] for entry in call.call_args_list] == [1]
    assert [entry.args[1]["value"] for entry in recovered.call_args_list] == [0]
    nodes = second.get_run(run_id)["nodeRuns"]
    assert any(node["nodeId"] == "STEP1" and node["status"] == "cancelled" for node in nodes)
    assert any(node["nodeId"] == "CLEAN" and node["status"] == "passed" for node in nodes)
    events = [event["type"] for event in second.get_run(run_id)["events"]]
    assert "run.recovery_cleanup_started" in events and "run.interrupted" in events
    await second.close()
    await first.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::resumes an "
    "idempotent orphan from the last confirmed node with a stable key"
)
async def test_idempotent_recovery() -> None:
    value = task()
    base = value["steps"][0]
    value["steps"] = [
        {
            **base,
            "stepId": name,
            "label": name,
            "arguments": {"value": {"kind": "literal", "value": number}},
            "idempotent": True,
        }
        for name, number in [("FIRST", 1), ("SECOND", 2)]
    ]

    async def measure(name: str, args: Json, options: Json) -> Json:
        if args["value"] == 2:
            await asyncio.Future()
        return {"accepted": True}

    call = AsyncMock(side_effect=measure)
    first, logs, *_ = fixture(value=value, call=call, safety={"cleanupBudgetMs": 40})
    await first.initialize()
    detail = await first.start_run()
    run_id = detail["run"]["runId"]
    await eventually(
        lambda: any(
            node["nodeId"] == "SECOND" and node["status"] == "running"
            for node in logs.archives.get(run_id, {}).get("nodeRuns", [])
        )
    )
    recovered = AsyncMock(return_value={"accepted": True})
    second, *_ = fixture(value=value, logs=copy.deepcopy(logs), call=recovered)
    await second.initialize()
    await eventually(lambda: second.get_run(run_id)["run"]["status"] == "passed")
    assert [entry.args[1]["value"] for entry in call.call_args_list] == [1, 2]
    assert [entry.args[1]["value"] for entry in recovered.call_args_list] == [2]
    assert (
        recovered.call_args.args[2]["metadata"]["idempotencyKey"]
        == call.call_args.args[2]["metadata"]["idempotencyKey"]
    )
    assert "run.recovery_resumed" in [event["type"] for event in second.get_run(run_id)["events"]]
    await second.close()
    await first.close()


@pytest.mark.ts_case(
    "packages/orchestration/src/task-orchestration-service.test.ts::records "
    "disabled steps as skipped nodes"
)
async def test_disabled_skipped() -> None:
    value = task()
    value["steps"].insert(
        0,
        {
            "stepId": "DISABLED",
            "label": "Disabled delay",
            "enabled": False,
            "type": "delay",
            "durationMs": {"kind": "literal", "value": 1},
        },
    )
    service, *_ = fixture(value=value)
    await service.initialize()
    detail = await service.start_run()
    await eventually(lambda: service.get_run(detail["run"]["runId"])["run"]["status"] == "passed")
    assert any(
        node["nodeId"] == "DISABLED" and node["status"] == "skipped"
        for node in service.get_run(detail["run"]["runId"])["nodeRuns"]
    )
    await service.close()
