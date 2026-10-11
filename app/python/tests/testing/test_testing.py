from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from jsonschema import Draft202012Validator, ValidationError

from teststand_backend.application import DefaultAuthorizer, ExecutionCoordinator
from teststand_backend.contracts.errors import AppError
from teststand_backend.testing import TestEngine, TestingApplication, TestPlanStore
from teststand_backend.testing.catalog import step_catalog
from teststand_backend.testing.compiler import compile_plan
from teststand_backend.testing.expression import evaluate
from teststand_backend.testing.journal import RunJournal
from teststand_backend.testing.models import empty_plan, schema_hash
from teststand_backend.testing.resolver import DeviceToolResolver
from teststand_backend.testing.runtime_state import RuntimeStateStore

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
            "externalName": f"device__{tool_name}",
            "remoteName": tool_name,
            "deviceId": hardware_id,
            "inputSchema": input_schema,
            "upstreamOutputSchema": self.output_schema,
            "resultSchema": self.output_schema,
            "annotations": {},
            "operationSemantics": {
                "kind": "read",
                "retry": "safe",
                "stateRequirements": [],
                "stateEffects": [],
                "evidenceType": "measurement",
                "trusted": True,
            },
        }
        tool["bindingRevision"] = schema_hash(
            {
                "input": input_schema,
                "result": self.output_schema,
                "operationSemantics": tool["operationSemantics"],
            }
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
        self.names: list[str] = []

    async def call_aggregated_tool(
        self, name: str, arguments: dict[str, Any], options: dict[str, Any] | None = None
    ) -> Any:
        hardware = name.split("__", 1)[0]
        self.names.append(name)
        self.calls += 1
        self.active[hardware] = self.active.get(hardware, 0) + 1
        self.max_active[hardware] = max(self.max_active.get(hardware, 0), self.active[hardware])
        try:
            await asyncio.sleep(self.delay)
            output = arguments.get("output", {"value": 1})
            return {"data": output, "meta": {}} if (options or {}).get("envelope") else output
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


async def test_switching_projects_forgets_the_previous_projects_runs(tmp_path: Path) -> None:
    projects = Projects(tmp_path / "a")
    engine = TestEngine(projects, Devices(), Resolver(), ExecutionCoordinator())
    completed = await finish(engine, await engine.start(plan_with(), {}))
    assert engine.current() == completed

    projects.root = tmp_path / "b"
    engine.runtime.initialize()
    assert engine.runtime.latest_run() is None
    assert engine.current() is None
    assert engine.get(completed["runId"]) is None
    assert engine.runs == {} and engine.recordings == {}

    projects.root = tmp_path / "a"
    reopened = engine.current()
    assert reopened is not None and reopened["runId"] == completed["runId"]


def test_restricted_cel_supports_data_access_and_rejects_calls() -> None:
    context = {"parameters": {"limit": 3}, "variables": {"value": 2}, "steps": {}}
    assert evaluate("variables.value < parameters.limit && true", context) is True
    with pytest.raises(AppError, match="Unknown function open"):
        evaluate("open('x')", context)


def test_step_catalog_exposes_concrete_invoke_tool_contract() -> None:
    invoke = next(item for item in step_catalog() if item["type"] == "InvokeTool")
    schema = invoke["settingsSchema"]
    assert schema["properties"]["errorPolicy"]["enum"] == ["error", "fail"]
    assert {"hardwareId", "toolName", "bindingRevision"} <= set(schema["required"])


def test_device_tool_catalog_rejects_unmanaged_hardware() -> None:
    catalog = SimpleNamespace(
        find_hardware=lambda hardware_id: {
            "hardwareId": hardware_id,
            "kind": "passive",
        }
    )
    devices = SimpleNamespace(list_devices=lambda: [], list_tools=lambda: [])
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
    path = tmp_path / ".teststand" / "plans" / "tagged.hhplan.yaml"
    path.write_text("schemaVersion: 1\nid: tagged\nname: !unsafe value\n", encoding="utf-8")
    with pytest.raises(AppError, match="Custom YAML tags"):
        store.load("tagged")


async def test_plan_store_preserves_yaml_comments_on_operations_and_save(tmp_path: Path) -> None:
    store = TestPlanStore(Projects(tmp_path), None)
    await store.create({"id": "comments", "name": "Comments"})
    path = tmp_path / ".teststand" / "plans" / "comments.hhplan.yaml"
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
        {
            "id": "assert_1",
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": "read",
            "arguments": {},
            "assertions": [{"metric": "result.value", "op": "eq", "value": 2}],
        },
        {"id": "after", "type": "PublishResult", "name": "after", "value": 7},
        cleanup=[{"id": "cleanup", "type": "PublishResult", "name": "cleanup", "value": 1}],
    )
    snapshot = await engine.start(plan, {})
    completed = await finish(engine, snapshot)
    assert completed["verdict"] == "Fail"
    names = [item["name"] for item in engine.runs[snapshot["runId"]].results]
    assert names == ["assert_1", "after", "cleanup"]
    run_dir = tmp_path / ".teststand" / "runs" / snapshot["runId"]
    # One file is the run's whole evidence (design doc §9.5).
    files = {path.name.removesuffix("-wal").removesuffix("-shm") for path in run_dir.iterdir()}
    assert files == {"run.sqlite"}
    journal = RunJournal(run_dir)
    assert journal.summary()["verdict"] == "Fail"
    assert [event["type"] for event in journal.events()][0] == "run.started"
    assert journal.plan()["schemaVersion"] == 2
    assert [item["name"] for item in journal.results()] == ["assert_1", "after", "cleanup"]


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


async def test_unknown_hardware_result_cannot_be_handled_as_fail(tmp_path: Path) -> None:
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
    assert completed["verdict"] == "Error"
    assert completed["outcomeKnown"] is False
    assert completed["recoveryRequired"] is True
    assert engine.current() == completed
    assert engine.runs[completed["runId"]].results == []


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
    assert devices.max_active["device"] == 1


async def test_execution_instances_capture_parallel_loop_and_evidence_context(
    tmp_path: Path,
) -> None:
    devices = Devices()
    devices.delay = 0.05
    engine = TestEngine(Projects(tmp_path), devices, Resolver(), ExecutionCoordinator())
    repeat = {
        "id": "repeat",
        "type": "Repeat",
        "count": 2,
        "children": [
            {
                "id": "parallel",
                "type": "Parallel",
                "children": [
                    {
                        "id": "left",
                        "type": "InvokeTool",
                        "hardwareId": "left-device",
                        "toolName": "read",
                        "arguments": {"output": {"volts": 3.3}},
                    },
                    {
                        "id": "right",
                        "type": "InvokeTool",
                        "hardwareId": "right-device",
                        "toolName": "read",
                        "arguments": {"output": {"volts": 5.0}},
                    },
                ],
            }
        ],
    }
    started = await engine.start(plan_with(repeat), {})
    run = engine.runs[started["runId"]]
    for _ in range(50):
        if len(run.snapshot()["activeExecutionIds"]) >= 2:
            break
        await asyncio.sleep(0.005)
    assert len(run.snapshot()["activeExecutionIds"]) >= 2

    completed = await finish(engine, started)
    step_events = [item for item in run.events if item["type"] == "step.started"]
    left_events = [item for item in step_events if item.get("stepId") == "left"]
    assert len({item["executionId"] for item in left_events}) == 2
    assert {item["iterationIndex"] for item in left_events} == {0, 1}
    parallel_events = [item for item in step_events if item.get("stepId") == "parallel"]
    assert all(item["parentExecutionId"] for item in parallel_events)
    branch_events = [item for item in step_events if item.get("branchIndex") is not None]
    assert {item["branchIndex"] for item in branch_events} == {0, 1}
    assert completed["activeExecutionIds"] == []
    assert all(item.get("executionId") for item in run.results)
    assert all(item.get("stepId") and item.get("executionId") for item in completed["operations"])
    assert any(item["type"] == "loop.iteration.started" for item in run.events)
    assert any(item["type"] == "loop.iteration.completed" for item in run.events)


async def test_execution_instances_capture_if_retry_and_assertion_source(
    tmp_path: Path,
) -> None:
    engine = TestEngine(Projects(tmp_path), Devices(), Resolver(), ExecutionCoordinator())
    plan = plan_with(
        {
            "id": "conditional",
            "type": "If",
            "condition": "true",
            "children": [{"id": "selected", "type": "Delay", "durationMs": 1}],
            "elseChildren": [{"id": "not_selected", "type": "Delay", "durationMs": 1}],
        },
        {
            "id": "retry",
            "type": "Retry",
            "attempts": 2,
            "children": [{"id": "retried", "type": "Delay", "durationMs": 1}],
        },
        {
            "id": "measure",
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": "read",
            "arguments": {"output": {"volts": 3.3}},
            "assertions": [{"metric": "result.volts", "op": "within", "value": [3.0, 3.6]}],
        },
    )
    completed = await finish(engine, await engine.start(plan, {}))
    run = engine.runs[completed["runId"]]
    branch = next(item for item in run.events if item["type"] == "control.branch.selected")
    assert branch["selectedBranch"] == "children"
    selected = next(item for item in run.events if item.get("stepId") == "selected")
    assert selected["parentExecutionId"] == branch["executionId"]
    attempt = next(item for item in run.events if item["type"] == "retry.attempt.completed")
    assert attempt["attemptIndex"] == 0
    verdict = next(item for item in run.results if item.get("kind") == "verdict")
    assert verdict["verdict"] == "Pass"
    assert verdict["sourceStepId"] == "measure"
    assert verdict["judge"]["type"] == "result"


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
    assert aborted["executionStatus"] == "Aborted"
    assert aborted["cleanupStatus"] == "Succeeded"
    assert aborted["state"] == "aborted"
    assert engine.runs[started["runId"]].results[-1]["name"] == "cleanup"


async def test_application_request_id_deduplicates_start(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    resolver = Resolver()
    devices = Devices()
    execution = ExecutionCoordinator()
    store = TestPlanStore(projects, None)
    engine = TestEngine(projects, devices, resolver, execution)
    wiring = SimpleNamespace(list_tasks=lambda _query: [])
    app = TestingApplication(DefaultAuthorizer(), store, engine, resolver, wiring)
    await store.create({"id": "dedup", "name": "Dedup"})
    validation = app.validate_plan(HUMAN, "dedup")
    start_input = {
        "planId": "dedup",
        "revision": 1,
        "executionRevision": validation["executionRevision"],
        "requestId": "run-1",
        "parameters": {},
    }
    run = await app.start_run(HUMAN, start_input)
    same = await app.start_run(HUMAN, start_input)
    assert same["runId"] == run["runId"]
    await finish(engine, run)

    restarted_store = TestPlanStore(projects, None)
    restarted_engine = TestEngine(projects, devices, resolver, execution)
    restarted = TestingApplication(
        DefaultAuthorizer(), restarted_store, restarted_engine, resolver, wiring
    )
    persisted_run = await restarted.start_run(HUMAN, start_input)
    assert persisted_run["runId"] == run["runId"]
    assert devices.calls == 0


async def test_pending_start_request_blocks_unknown_duplicate(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    resolver = Resolver()
    store = TestPlanStore(projects, None)
    await store.create({"id": "pending", "name": "Pending"})
    validation = store.validate("pending")
    input = {
        "planId": "pending",
        "revision": 1,
        "executionRevision": validation["executionRevision"],
        "requestId": "run-pending",
        "parameters": {},
    }
    assert await store.claim_request("start", "run-pending", input) is None
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
            input,
        )
    assert failure.value.category == "conflict"
    assert failure.value.details["outcomeKnown"] is False


class WiredProjects(Projects):
    def wiring(self) -> dict[str, Any]:
        return {"nodes": [], "connections": [{"from": "dev.P1", "to": "dut.J1"}]}


async def test_start_gate_only_blocks_wiring_tasks_for_plan_hardware(tmp_path: Path) -> None:
    projects = WiredProjects(tmp_path)
    resolver = Resolver()
    store = TestPlanStore(projects, resolver)
    engine = TestEngine(projects, Devices(), resolver, ExecutionCoordinator())
    tasks: list[dict[str, Any]] = [
        {"status": "pending", "portA": "other.P1", "portB": "dut.J2"},
        {"status": "completed", "portA": "dev.P2", "portB": "dut.J3"},
    ]
    app = TestingApplication(
        DefaultAuthorizer(), store, engine, resolver, SimpleNamespace(list_tasks=lambda _q: tasks)
    )
    invoke = {
        "id": "read",
        "type": "InvokeTool",
        "hardwareId": "dev",
        "toolName": "read",
        "arguments": {},
        "timeoutMs": 1000,
        "bindingRevision": resolver.resolve("dev", "read")[0]["bindingRevision"],
    }
    await store.create(
        {
            "id": "gate",
            "name": "Gate",
            "regions": {"prepare": [], "test": [invoke], "cleanup": []},
        }
    )
    validation = app.validate_plan(HUMAN, "gate")
    start_input = {
        "planId": "gate",
        "revision": 1,
        "executionRevision": validation["executionRevision"],
        "parameters": {},
    }

    tasks.append({"status": "in_progress", "portA": "dut.J4", "portB": "dev.P3"})
    with pytest.raises(AppError) as failure:
        await app.start_run(HUMAN, {**start_input, "requestId": "run-blocked"})
    assert failure.value.category == "conflict"

    tasks.pop()
    run = await finish(engine, await app.start_run(HUMAN, {**start_input, "requestId": "run-ok"}))
    run_dir = tmp_path / ".teststand" / "runs" / run["runId"]
    assert RunJournal(run_dir).wiring() == projects.wiring()


def test_resolver_exposes_unwrapped_business_result_contract() -> None:
    envelope = {
        "type": "object",
        "properties": {
            "ok": {"const": True},
            "data": {
                "type": "object",
                "properties": {"volts": {"type": "number"}},
                "required": ["volts"],
                "additionalProperties": False,
            },
        },
        "required": ["ok", "data"],
    }
    devices = SimpleNamespace(
        list_devices=lambda: [{"deviceId": "device", "hardwareId": "dev"}],
        list_tools=lambda: [
            {
                "deviceId": "device",
                "remoteName": "read_voltage",
                "externalName": "device__read_voltage",
                "inputSchema": {"type": "object"},
                "upstreamOutputSchema": envelope,
                "annotations": {"readOnlyHint": True},
            }
        ],
    )
    catalog = SimpleNamespace(find_hardware=lambda _identifier: {"kind": "managed"})
    tool, issues = DeviceToolResolver(devices, catalog).resolve("dev", "read_voltage")
    assert issues == [] and tool
    Draft202012Validator(tool["resultSchema"]).validate({"volts": 1.2})
    with pytest.raises(ValidationError):
        Draft202012Validator(tool["resultSchema"]).validate({"ok": True, "data": {"volts": 1.2}})
    assert tool["bindingRevision"]


def test_compiler_rejects_missing_output_fields_and_non_dominating_steps() -> None:
    resolver = Resolver(
        {
            "type": "object",
            "properties": {"volts": {"type": "number"}},
            "required": ["volts"],
            "additionalProperties": False,
        }
    )
    binding, _ = resolver.resolve("dev", "read")
    plan = plan_with(
        {
            "id": "conditional",
            "type": "If",
            "condition": "true",
            "children": [
                {
                    "id": "measurement",
                    "type": "InvokeTool",
                    "hardwareId": "dev",
                    "toolName": "read",
                    "bindingRevision": binding["bindingRevision"],
                    "arguments": {},
                }
            ],
            "elseChildren": [],
        },
        {
            "id": "assertion",
            "type": "PublishResult",
            "valueExpression": "steps.measurement.missing",
        },
    )
    compiled = compile_plan(plan, resolver)
    codes = {item["code"] for item in compiled["issues"]}
    assert "expression.control_flow" in codes
    assert compiled["valid"] is False


def test_compiler_requires_device_state_to_dominate_control_flow() -> None:
    class StatefulResolver(Resolver):
        def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
            tool, issues = super().resolve(hardware_id, tool_name)
            semantics = tool["operationSemantics"]
            semantics["stateEffects"] = ["configured"] if tool_name == "configure" else []
            semantics["stateRequirements"] = ["configured"] if tool_name == "read" else []
            tool["bindingRevision"] = schema_hash(
                {
                    "input": tool["inputSchema"],
                    "result": tool["resultSchema"],
                    "operationSemantics": semantics,
                }
            )
            return tool, issues

    resolver = StatefulResolver()

    def invoke(step_id: str, tool_name: str) -> dict[str, Any]:
        binding, _ = resolver.resolve("dev", tool_name)
        return {
            "id": step_id,
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": tool_name,
            "bindingRevision": binding["bindingRevision"],
            "arguments": {},
        }

    conditional = compile_plan(
        plan_with(
            {
                "id": "conditional",
                "type": "If",
                "condition": "true",
                "children": [invoke("configure_yes", "configure")],
                "elseChildren": [],
            },
            invoke("read_after", "read"),
        ),
        resolver,
    )
    parallel = compile_plan(
        plan_with(
            {
                "id": "parallel",
                "type": "Parallel",
                "children": [
                    invoke("configure_parallel", "configure"),
                    invoke("read_parallel", "read"),
                ],
            }
        ),
        resolver,
    )

    assert "device.state_requirement" in {item["code"] for item in conditional["issues"]}
    assert "device.state_requirement" in {item["code"] for item in parallel["issues"]}


async def test_cleanup_is_top_down_and_system_safety_runs_afterward(tmp_path: Path) -> None:
    class SafetyResolver(Resolver):
        def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
            tool, issues = super().resolve(hardware_id, tool_name)
            tool["externalName"] = f"device__{tool_name}"
            tool["operationSemantics"] = {
                "kind": "safe" if tool_name == "safe" else "actuate",
                "retry": "never_after_dispatch",
                "stateRequirements": [],
                "stateEffects": [],
                "evidenceType": "observation",
                "trusted": True,
                **(
                    {"safetyAction": {"toolName": "safe", "arguments": {}}}
                    if tool_name == "drive"
                    else {}
                ),
            }
            return tool, issues

    devices = Devices()
    engine = TestEngine(Projects(tmp_path), devices, SafetyResolver(), ExecutionCoordinator())
    plan = plan_with(
        {
            "id": "drive",
            "type": "InvokeTool",
            "hardwareId": "dev",
            "toolName": "drive",
            "arguments": {},
        },
        cleanup=[
            {"id": "cleanup_first", "type": "PublishResult", "name": "first", "value": 1},
            {"id": "cleanup_second", "type": "PublishResult", "name": "second", "value": 2},
        ],
    )
    completed = await finish(engine, await engine.start(plan, {}))
    assert [item["name"] for item in engine.runs[completed["runId"]].results] == [
        "first",
        "second",
    ]
    assert devices.names == ["device__drive", "device__safe"]
    assert completed["cleanupStatus"] == "Succeeded"


async def test_cleanup_failure_recovered_by_system_safety_preserves_dut_verdict(
    tmp_path: Path,
) -> None:
    class SafetyResolver(Resolver):
        def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
            tool, issues = super().resolve(hardware_id, tool_name)
            tool["externalName"] = f"device__{tool_name}"
            tool["operationSemantics"] = {
                "kind": "safe" if tool_name == "safe" else "actuate",
                "retry": "never_after_dispatch",
                "stateRequirements": [],
                "stateEffects": [],
                "evidenceType": "observation",
                "trusted": True,
                **(
                    {"safetyAction": {"toolName": "safe", "arguments": {}}}
                    if tool_name == "drive"
                    else {}
                ),
            }
            return tool, issues

    class CleanupFailureDevices(Devices):
        async def call_aggregated_tool(
            self, name: str, arguments: dict[str, Any], options: dict[str, Any] | None = None
        ) -> Any:
            if name.endswith("__cleanup_fail"):
                raise AppError(
                    "unavailable",
                    "cleanup transport disconnected",
                    {"outcomeKnown": False, "recoveryRequired": True},
                )
            return await super().call_aggregated_tool(name, arguments, options)

    engine = TestEngine(
        Projects(tmp_path), CleanupFailureDevices(), SafetyResolver(), ExecutionCoordinator()
    )
    completed = await finish(
        engine,
        await engine.start(
            plan_with(
                {
                    "id": "drive",
                    "type": "InvokeTool",
                    "hardwareId": "dev",
                    "toolName": "drive",
                    "arguments": {},
                },
                cleanup=[
                    {
                        "id": "cleanup_fail",
                        "type": "InvokeTool",
                        "hardwareId": "dev",
                        "toolName": "cleanup_fail",
                        "arguments": {},
                    }
                ],
            ),
            {},
        ),
    )
    assert completed["verdict"] == "Pass"
    assert completed["executionStatus"] == "Succeeded"
    assert completed["cleanupStatus"] == "Recovered"
    assert completed["safetyStatus"] == "Verified"
    assert completed["state"] == "completed"
    assert completed["recoveryRequired"] is False
    assert completed["outcomeKnown"] is False
    assert completed["primaryError"]["recovered"] is True
    recovered = next(item for item in completed["operations"] if item["toolName"] == "cleanup_fail")
    assert recovered["resolvedByOperationId"]


async def test_cleanup_failure_without_safety_is_separate_from_dut_verdict(
    tmp_path: Path,
) -> None:
    class CleanupFailureDevices(Devices):
        async def call_aggregated_tool(
            self, name: str, arguments: dict[str, Any], options: dict[str, Any] | None = None
        ) -> Any:
            raise AppError("unavailable", "cleanup failed", {"outcomeKnown": False})

    engine = TestEngine(
        Projects(tmp_path), CleanupFailureDevices(), Resolver(), ExecutionCoordinator()
    )
    completed = await finish(
        engine,
        await engine.start(
            plan_with(
                cleanup=[
                    {
                        "id": "cleanup_fail",
                        "type": "InvokeTool",
                        "hardwareId": "dev",
                        "toolName": "cleanup_fail",
                        "arguments": {},
                    }
                ]
            ),
            {},
        ),
    )
    assert completed["verdict"] == "Pass"
    assert completed["executionStatus"] == "Failed"
    assert completed["cleanupStatus"] == "Failed"
    assert completed["safetyStatus"] == "Unknown"
    assert completed["state"] == "error"


def test_dispatched_operation_becomes_recovery_required_after_restart(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    state = RuntimeStateStore(projects)
    state.initialize()
    state.record_operation(
        {
            "operationId": "op",
            "runId": "run",
            "hardwareId": "dev",
            "toolName": "write",
            "inputHash": "hash",
            "state": "dispatched",
        }
    )
    restarted = RuntimeStateStore(projects)
    restarted.initialize()
    operation = restarted.operations(recovery_only=True)[0]
    assert operation["state"] == "outcome_unknown"
    assert operation["outcomeKnown"] is False


def test_runtime_state_migrates_operation_execution_context_columns(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    path = tmp_path / ".teststand" / "runtime.sqlite3"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as database:
        database.execute(
            "CREATE TABLE operations (operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,"
            "hardware_id TEXT NOT NULL,tool_name TEXT NOT NULL,input_hash TEXT NOT NULL,"
            "state TEXT NOT NULL,outcome_known INTEGER NOT NULL,recovery_required INTEGER NOT NULL,"
            "result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
        )
    state = RuntimeStateStore(projects)
    state.initialize()
    state.record_operation(
        {
            "operationId": "op-context",
            "runId": "run",
            "hardwareId": "dev",
            "toolName": "read",
            "inputHash": "hash",
            "state": "succeeded",
            "stepId": "measure",
            "executionId": "execution-1",
        }
    )
    operation = state.operations("run")[0]
    assert operation["stepId"] == "measure"
    assert operation["executionId"] == "execution-1"


def test_run_history_indexes_artifacts_filters_and_pages(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    state = RuntimeStateStore(projects)
    state.initialize()
    for index, verdict in enumerate(("Pass", "Fail", "Pass")):
        run_id = f"run-{index}"
        journal = RunJournal(tmp_path / ".teststand" / "runs" / run_id)
        journal.create({"id": "plan"})
        journal.finish(
            {
                "runId": run_id,
                "planId": "plan-a" if index < 2 else "plan-b",
                "planName": f"Plan {index}",
                "revision": 1,
                "state": "completed",
                "verdict": verdict,
                "startedAt": f"2026-09-18T00:00:0{index}Z",
                "cleanupStatus": "Succeeded",
                "outcomeKnown": True,
                "recoveryRequired": False,
            },
            [],
        )
    first = state.list_runs(limit=1, verdict="Pass")
    assert [item["runId"] for item in first["items"]] == ["run-2"]
    second = state.list_runs(limit=1, verdict="Pass", cursor=first["nextCursor"])
    assert [item["runId"] for item in second["items"]] == ["run-0"]
    assert state.list_runs(plan_id="plan-a")["items"][0]["runId"] == "run-1"


def test_read_run_log_restores_plan_and_incremental_artifacts(tmp_path: Path) -> None:
    projects = Projects(tmp_path)
    state = RuntimeStateStore(projects)
    state.initialize()
    snapshot = {
        "runId": "run",
        "planId": "plan",
        "planName": "Plan",
        "revision": 1,
        "state": "completed",
        "verdict": "Pass",
        "startedAt": "2026-09-18T00:00:00Z",
        "sequence": 2,
        "resultSequence": 2,
    }
    state.save_run(snapshot)
    journal = RunJournal(tmp_path / ".teststand" / "runs" / "run")
    journal.create(
        {"id": "plan", "name": "Plan", "regions": {"prepare": [], "test": [], "cleanup": []}}
    )
    journal.append_event({"sequence": 1, "type": "run.started"})
    journal.append_event({"sequence": 2, "type": "run.completed"})
    journal.append_result({"sequence": 1, "name": "old"})
    journal.append_result({"sequence": 2, "name": "new"})
    journal.close()
    engine = TestEngine(
        projects, Devices(), Resolver(), ExecutionCoordinator(), runtime_state=state
    )
    value = engine.read_log("run", after_event_sequence=1, after_result_sequence=1)
    assert value["plan"]["id"] == "plan"
    assert [event["sequence"] for event in value["events"]] == [2]
    assert [result["sequence"] for result in value["results"]] == [2]
    first_page = engine.read_log("run", event_limit=1, result_limit=1)
    assert first_page["hasMoreEvents"] is True
    assert first_page["hasMoreResults"] is True
    assert first_page["latestEventSequence"] == 2
    assert first_page["latestResultSequence"] == 2


def test_latest_run_is_none_without_an_open_project() -> None:
    class Closed:
        def session(self) -> None:
            return None

    state = RuntimeStateStore(Closed())
    assert state.latest_run() is None


def test_binding_a_tool_fills_only_declared_defaults() -> None:
    from teststand_backend.testing.store import default_arguments

    schema = {
        "type": "object",
        "properties": {
            "channel": {"type": "integer", "minimum": 0},
            "closed": {"type": "boolean"},
            "kind": {"type": "string", "enum": ["DI", "RELAY"]},
            "volts": {"type": "number", "default": 1.5},
            "note": {"type": "string"},
            "optional": {"type": "integer"},
        },
        "required": ["channel", "closed", "kind", "volts", "note"],
    }
    assert default_arguments(schema) == {"volts": 1.5}
    assert default_arguments({}) == {}


class SchemaResolver(Resolver):
    def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
        tool, issues = super().resolve(hardware_id, tool_name)
        tool["inputSchema"] = {
            "type": "object",
            "properties": {"channel": {"type": "integer"}, "volts": {"type": "number"}},
            "required": ["channel", "volts"],
        }
        return tool, issues


async def test_binding_keeps_arguments_already_set(tmp_path: Path) -> None:
    store = TestPlanStore(Projects(tmp_path), SchemaResolver())
    await store.create({"id": "bind", "name": "Bind"})
    step = {"id": "set", "type": "InvokeTool", "arguments": {"channel": 1, "volts": 2.5}}
    await store.apply_operations("bind", 1, [{"type": "insert_step", "step": step}])
    bound = await store.apply_operations(
        "bind",
        2,
        [{"type": "bind_invoke_tool", "stepId": "set", "hardwareId": "ao", "toolName": "write"}],
    )
    invoke = bound["plan"]["regions"]["test"][0]
    assert invoke["arguments"] == {"channel": 1, "volts": 2.5}
    assert invoke["toolName"] == "write"
    rebound = await store.apply_operations(
        "bind",
        3,
        [{"type": "bind_invoke_tool", "stepId": "set", "hardwareId": "ao", "toolName": "read"}],
    )
    assert rebound["plan"]["regions"]["test"][0]["arguments"] == {"channel": 1, "volts": 2.5}


async def test_insert_step_binds_invoke_tools_nested_in_a_container(tmp_path: Path) -> None:
    """A Feature arrives with its children; every InvokeTool inside is bound, not just the root."""
    from teststand_backend.testing.validation import validate_plan

    store = TestPlanStore(Projects(tmp_path), SchemaResolver())
    await store.create({"id": "nest", "name": "Nest"})
    feature = {
        "id": "feat",
        "type": "Feature",
        "name": "继电器",
        "children": [
            {"id": "set", "type": "InvokeTool", "hardwareId": "ao", "toolName": "write"},
            {"id": "wait", "type": "Delay", "durationMs": 10},
            {
                "id": "guard",
                "type": "Guard",
                "children": [
                    {"id": "deep", "type": "InvokeTool", "hardwareId": "ao", "toolName": "read"}
                ],
            },
        ],
    }
    result = await store.apply_operations("nest", 1, [{"type": "insert_step", "step": feature}])
    children = result["plan"]["regions"]["test"][0]["children"]
    assert children[0]["bindingRevision"]
    assert children[2]["children"][0]["bindingRevision"]
    # Validation has nothing to complain about, so no repair operation is needed.
    codes = [item["code"] for item in validate_plan(result["plan"], SchemaResolver(), [])]
    assert "invoke.binding" not in codes


async def test_step_fields_wrapped_in_settings_are_rejected(tmp_path: Path) -> None:
    from teststand_backend.testing.validation import validate_plan

    plan = plan_with({"id": "d", "type": "Delay", "settings": {"durationMs": 5}})
    assert "step.settings" in [item["code"] for item in validate_plan(plan, None, [])]
    store = TestPlanStore(Projects(tmp_path), SchemaResolver())
    await store.create({"id": "wrap", "name": "Wrap"})
    wrapped = {"id": "d", "type": "Delay", "settings": {"durationMs": 5}}
    with pytest.raises(AppError, match="no settings"):
        await store.apply_operations("wrap", 1, [{"type": "insert_step", "step": wrapped}])
    await store.apply_operations(
        "wrap", 1, [{"type": "insert_step", "step": {"id": "d", "type": "Delay"}}]
    )
    with pytest.raises(AppError, match="no settings"):
        await store.apply_operations(
            "wrap",
            2,
            [{"type": "update_step", "stepId": "d", "patch": {"settings": {"durationMs": 5}}}],
        )
