from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from hardwareharness_backend.application import DefaultAuthorizer, ExecutionCoordinator
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.testing import TestEngine, TestingApplication, TestPlanStore
from hardwareharness_backend.testing.catalog import step_catalog
from hardwareharness_backend.testing.expression import evaluate
from hardwareharness_backend.testing.models import empty_plan, schema_hash
from hardwareharness_backend.testing.resolver import DeviceToolResolver

HUMAN = {"actor": "human", "source": "desktop"}


class Projects:
    def __init__(self, root: Path) -> None:
        self.root = root

    def session(self) -> dict[str, str]:
        return {"projectId": "project", "rootPath": str(self.root)}


class Resolver:
    def __init__(self, output_schema: dict[str, Any] | None = None) -> None:
        self.output_schema = output_schema or {}

    def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
        input_schema = {"type": "object", "properties": {}, "additionalProperties": True}
        tool = {
            "externalName": f"server__{tool_name}",
            "remoteName": tool_name,
            "serverId": hardware_id,
            "inputSchema": input_schema,
            "upstreamOutputSchema": self.output_schema,
            "annotations": {},
        }
        tool["inputSchemaHash"] = schema_hash(input_schema)
        tool["toolContractRevision"] = schema_hash(
            {"input": input_schema, "output": self.output_schema, "annotations": {}}
        )
        return tool, []

    def list_device_tools(self, hardware_id: str) -> dict[str, Any]:
        tool, _ = self.resolve(hardware_id, "read")
        return {"hardwareId": hardware_id, "tools": [tool], "issues": []}


class Devices:
    def __init__(self) -> None:
        self.calls = 0
        self.active: dict[str, int] = {}
        self.max_active: dict[str, int] = {}
        self.delay = 0.01

    async def call_aggregated_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        hardware = name.split("__", 1)[0]
        self.calls += 1
        self.active[hardware] = self.active.get(hardware, 0) + 1
        self.max_active[hardware] = max(self.max_active.get(hardware, 0), self.active[hardware])
        try:
            await asyncio.sleep(self.delay)
            return arguments.get("output", {"value": 1})
        finally:
            self.active[hardware] -= 1


class SamplePlugin:
    type_name = "SamplePlugin"
    settings_schema = {"type": "object"}
    output_schema = {"type": "object"}

    def __init__(self) -> None:
        self.context_was_restricted = False

    def validate(self, step: dict[str, Any]) -> list[dict[str, Any]]:
        if step.get("requiredSetting") == "ok":
            return []
        return [
            {
                "severity": "error",
                "code": "sample.required",
                "message": "requiredSetting must be ok",
                "path": "/requiredSetting",
            }
        ]

    async def prepare(self, context: Any, _step: dict[str, Any]) -> None:
        self.context_was_restricted = not hasattr(context, "engine")

    async def run(self, context: Any, _step: dict[str, Any]) -> dict[str, Any]:
        await context.checkpoint()
        context.publish_result({"name": "plugin", "value": 1})
        return {"value": 1}

    async def cleanup(self, _context: Any, _step: dict[str, Any]) -> None:
        return None


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


def test_restricted_cel_supports_data_access_and_rejects_calls() -> None:
    context = {"parameters": {"limit": 3}, "variables": {"value": 2}, "steps": {}}
    assert evaluate("variables.value < parameters.limit && true", context) is True
    with pytest.raises(AppError, match="Unsupported CEL syntax"):
        evaluate("open('x')", context)


def test_step_catalog_exposes_concrete_invoke_tool_contract() -> None:
    invoke = next(item for item in step_catalog() if item["type"] == "InvokeTool")
    schema = invoke["settingsSchema"]
    assert schema["properties"]["errorPolicy"]["enum"] == ["error", "fail"]
    assert {"hardwareId", "toolName", "toolContractRevision", "inputSchemaHash"} <= set(
        schema["required"]
    )


def test_device_tool_catalog_rejects_unmanaged_hardware() -> None:
    catalog = SimpleNamespace(
        find_hardware=lambda hardware_id: {
            "hardwareId": hardware_id,
            "kind": "passive",
        }
    )
    devices = SimpleNamespace(list_servers=lambda: [], list_tools=lambda: [])
    result = DeviceToolResolver(devices, catalog).list_device_tools("fixture")
    assert result["tools"] == []
    assert result["issues"][0]["code"] == "device.unmanaged"


async def test_plan_store_revision_operations_and_yaml_tag_rejection(tmp_path: Path) -> None:
    store = TestPlanStore(Projects(tmp_path), None)
    created = await store.create({"id": "alpha", "name": "Alpha"})
    assert created["plan"]["revision"] == 1
    updated = await store.apply_operations(
        "alpha",
        1,
        [
            {
                "type": "insert_step",
                "region": "test",
                "step": {"id": "delay_1", "type": "Delay", "durationMs": 1},
            },
            {"type": "set_plan_fields", "patch": {"description": "changed"}},
        ],
    )
    assert updated["plan"]["revision"] == 2
    assert store.load("alpha")["regions"]["test"][0]["id"] == "delay_1"
    with pytest.raises(AppError) as conflict:
        await store.apply_operations("alpha", 1, [])
    assert conflict.value.category == "conflict"
    path = tmp_path / ".hardwareharness" / "plans" / "tagged.hhplan.yaml"
    path.write_text("schemaVersion: 1\nid: tagged\nname: !unsafe value\n", encoding="utf-8")
    with pytest.raises(AppError, match="Custom YAML tags"):
        store.load("tagged")


async def test_plan_store_preserves_yaml_comments_on_operations_and_save(tmp_path: Path) -> None:
    store = TestPlanStore(Projects(tmp_path), None)
    await store.create({"id": "comments", "name": "Comments"})
    path = tmp_path / ".hardwareharness" / "plans" / "comments.hhplan.yaml"
    path.write_text("# operator note\n" + path.read_text(encoding="utf-8"), encoding="utf-8")
    changed = await store.apply_operations(
        "comments", 1, [{"type": "set_plan_fields", "patch": {"description": "updated"}}]
    )
    assert path.read_text(encoding="utf-8").startswith("# operator note\n")
    changed["plan"]["name"] = "Saved"
    await store.save(changed["plan"], 2)
    assert path.read_text(encoding="utf-8").startswith("# operator note\n")


async def test_fail_continues_and_cleanup_always_runs(tmp_path: Path) -> None:
    devices = Devices()
    engine = TestEngine(Projects(tmp_path), devices, Resolver(), ExecutionCoordinator())
    plan = plan_with(
        {"id": "assert_1", "type": "Equal", "actual": 1, "expected": 2},
        {"id": "after", "type": "PublishResult", "name": "after", "value": 7},
        cleanup=[{"id": "cleanup", "type": "PublishResult", "name": "cleanup", "value": 1}],
    )
    snapshot = await engine.start(plan, {})
    completed = await finish(engine, snapshot)
    assert completed["verdict"] == "Fail"
    names = [item["name"] for item in engine.runs[snapshot["runId"]].results]
    assert names == ["assert_1", "after", "cleanup"]
    run_dir = tmp_path / ".hardwareharness" / "runs" / snapshot["runId"]
    assert json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))["verdict"] == "Fail"
    assert (run_dir / "events.jsonl").exists()
    snapshot = (run_dir / "plan.hhplan.yaml").read_text(encoding="utf-8")
    assert "schemaVersion: 1" in snapshot
    assert not (run_dir / "plan.hhplan.json").exists()


async def test_error_enters_cleanup_and_output_schema_is_enforced(tmp_path: Path) -> None:
    resolver = Resolver({"type": "object", "required": ["measurement"]})
    devices = Devices()
    engine = TestEngine(Projects(tmp_path), devices, resolver, ExecutionCoordinator())
    plan = plan_with(
        {
            "id": "invoke",
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": "read",
            "arguments": {"output": {"wrong": 1}},
            "timeoutMs": 1000,
        },
        {"id": "never", "type": "PublishResult", "name": "never", "value": 1},
        cleanup=[{"id": "cleanup", "type": "PublishResult", "name": "cleanup", "value": 1}],
    )
    completed = await finish(engine, await engine.start(plan, {}))
    assert completed["verdict"] == "Error"
    run = engine.runs[completed["runId"]]
    assert [item["name"] for item in run.results] == ["cleanup"]


async def test_known_hardware_error_can_be_handled_as_fail(tmp_path: Path) -> None:
    resolver = Resolver({"type": "object", "required": ["measurement"]})
    devices = Devices()
    engine = TestEngine(Projects(tmp_path), devices, resolver, ExecutionCoordinator())
    plan = plan_with(
        {
            "id": "invoke",
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": "read",
            "arguments": {"output": {"wrong": 1}},
            "timeoutMs": 1000,
            "errorPolicy": "fail",
        },
        {"id": "after", "type": "PublishResult", "name": "after", "value": 1},
    )
    completed = await finish(engine, await engine.start(plan, {}))
    assert completed["verdict"] == "Fail"
    assert engine.current() == completed
    assert engine.runs[completed["runId"]].results[-1]["name"] == "after"


async def test_plugin_validation_and_restricted_execution_context(tmp_path: Path) -> None:
    plugin = SamplePlugin()
    store = TestPlanStore(Projects(tmp_path), None, [plugin])
    created = await store.create(
        {
            "id": "plugin-plan",
            "name": "Plugin",
            "regions": {
                "prepare": [],
                "test": [{"id": "plugin", "type": "SamplePlugin"}],
                "cleanup": [],
            },
        }
    )
    assert created["issues"][0]["path"].endswith("/requiredSetting")
    plan = created["plan"]
    plan["regions"]["test"][0]["requiredSetting"] = "ok"
    engine = TestEngine(Projects(tmp_path), Devices(), Resolver(), ExecutionCoordinator(), [plugin])
    completed = await finish(engine, await engine.start(plan, {}))
    assert completed["verdict"] == "Pass"
    assert plugin.context_was_restricted is True


async def test_parallel_serializes_same_hardware(tmp_path: Path) -> None:
    devices = Devices()
    engine = TestEngine(Projects(tmp_path), devices, Resolver(), ExecutionCoordinator())
    children = [
        {
            "id": f"invoke_{index}",
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": "read",
            "arguments": {},
            "timeoutMs": 1000,
        }
        for index in range(2)
    ]
    completed = await finish(
        engine,
        await engine.start(
            plan_with({"id": "parallel", "type": "Parallel", "children": children}), {}
        ),
    )
    assert completed["verdict"] == "Pass"
    assert devices.max_active["server"] == 1


async def test_abort_cleans_up_and_unknown_timeout_is_not_retried(tmp_path: Path) -> None:
    devices = Devices()
    devices.delay = 0.2
    engine = TestEngine(Projects(tmp_path), devices, Resolver(), ExecutionCoordinator())
    retry = {
        "id": "retry",
        "type": "Retry",
        "attempts": 3,
        "children": [
            {
                "id": "invoke",
                "type": "InvokeTool",
                "hardwareId": "dev",
                "toolName": "write",
                "arguments": {},
                "timeoutMs": 10,
            }
        ],
    }
    completed = await finish(engine, await engine.start(plan_with(retry), {}))
    assert completed["verdict"] == "Error"
    assert devices.calls == 1

    abort_plan = plan_with(
        {"id": "delay", "type": "Delay", "durationMs": 500},
        cleanup=[{"id": "cleanup", "type": "PublishResult", "name": "cleanup", "value": 1}],
    )
    started = await engine.start(abort_plan, {})
    await engine.abort(started["runId"])
    aborted = await finish(engine, started)
    assert aborted["verdict"] == "Aborted"
    assert engine.runs[started["runId"]].results[-1]["name"] == "cleanup"


async def test_application_request_id_deduplicates_create_and_start(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    resolver = Resolver()
    devices = Devices()
    execution = ExecutionCoordinator()
    store = TestPlanStore(projects, None)
    engine = TestEngine(projects, devices, resolver, execution)
    wiring = SimpleNamespace(list_tasks=lambda _query: [])
    app = TestingApplication(DefaultAuthorizer(), store, engine, resolver, wiring)
    first = await app.create_plan(HUMAN, {"requestId": "create-1", "id": "dedup", "name": "Dedup"})
    second = await app.create_plan(HUMAN, {"requestId": "create-1", "id": "other", "name": "Other"})
    assert first == second
    start_input = {"planId": "dedup", "revision": 1, "requestId": "run-1", "parameters": {}}
    run = await app.start_run(HUMAN, start_input)
    same = await app.start_run(HUMAN, start_input)
    assert same["runId"] == run["runId"]
    await finish(engine, run)

    restarted_store = TestPlanStore(projects, None)
    restarted_engine = TestEngine(projects, devices, resolver, execution)
    restarted = TestingApplication(
        DefaultAuthorizer(), restarted_store, restarted_engine, resolver, wiring
    )
    persisted_create = await restarted.create_plan(
        HUMAN, {"requestId": "create-1", "id": "ignored", "name": "Ignored"}
    )
    persisted_run = await restarted.start_run(HUMAN, start_input)
    assert persisted_create == first
    assert persisted_run["runId"] == run["runId"]
    assert devices.calls == 0


async def test_pending_start_request_blocks_unknown_duplicate(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    resolver = Resolver()
    store = TestPlanStore(projects, None)
    await store.create({"id": "pending", "name": "Pending"})
    assert await store.claim_request("start", "run-pending") is None
    engine = TestEngine(projects, Devices(), resolver, ExecutionCoordinator())
    app = TestingApplication(
        DefaultAuthorizer(),
        TestPlanStore(projects, None),
        engine,
        resolver,
        SimpleNamespace(list_tasks=lambda _query: []),
    )
    with pytest.raises(AppError) as failure:
        await app.start_run(
            HUMAN,
            {
                "planId": "pending",
                "revision": 1,
                "requestId": "run-pending",
                "parameters": {},
            },
        )
    assert failure.value.category == "conflict"
    assert failure.value.details["outcomeKnown"] is False
