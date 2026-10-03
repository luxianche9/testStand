"""The interpreter runs a plan against injected fakes only: no project, no files, no devices."""

from __future__ import annotations

import asyncio
import itertools
from typing import Any

from hardwareharness_backend.testing.interpreter import RunInterpreter, RunPorts

Record = dict[str, Any]


class FakeOperations:
    def __init__(self) -> None:
        self.saved: list[Record] = []
        self.items: dict[str, Record] = {}

    def save_run(self, snapshot: Record) -> None:
        self.saved.append(snapshot)

    def record_operation(self, operation: Record) -> None:
        self.items[operation["operationId"]] = dict(operation)

    def update_operation(self, operation_id: str, **changes: Any) -> None:
        self.items[operation_id].update(changes)

    def operations(self, run_id: str | None = None, recovery_only: bool = False) -> list[Record]:
        return [
            item
            for item in self.items.values()
            if (run_id is None or item["runId"] == run_id)
            and (not recovery_only or item.get("recoveryRequired"))
        ]


class FakeJournal:
    def __init__(self) -> None:
        self.plan: Record | None = None
        self.events: list[Record] = []
        self.results: list[Record] = []
        self.summary: Record | None = None

    def create(self, plan: Record) -> None:
        self.plan = plan

    def append_event(self, event: Record) -> None:
        self.events.append(event)

    def append_result(self, result: Record) -> None:
        self.results.append(result)

    def finish(self, summary: Record, events: list[Record]) -> None:
        self.summary = summary


class FakeStreams:
    def __init__(self) -> None:
        self.started: list[str] | None = None
        self.stopped = False
        self.locks: dict[str, asyncio.Lock] = {}

    async def start(self, hardware_ids: list[str], protocols: Any = None) -> None:
        self.started = hardware_ids

    async def stop(self) -> None:
        self.stopped = True

    def device_lock(self, hardware_id: str) -> asyncio.Lock:
        return self.locks.setdefault(hardware_id, asyncio.Lock())

    def timing(
        self, hardware_id: str, backend_start: float, backend_end: float, meta: Record | None
    ) -> Record:
        return {"backendStart": backend_start, "backendEnd": backend_end}


class FakeDevices:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Record, Record]] = []

    async def call_aggregated_tool(self, name: str, arguments: Record, options: Record) -> Record:
        self.calls.append((name, arguments, options))
        return {"data": {"value": 3.3}, "meta": {}}


class FakeResolver:
    def resolve(self, hardware_id: str, tool_name: str) -> tuple[Record, list[Record]]:
        return {"externalName": f"{hardware_id}.{tool_name}", "operationSemantics": {}}, []


class FakeExecution:
    def __init__(self) -> None:
        self.released = False

    def acquire(self, activity: Record) -> FakeExecution:
        return self

    def release(self) -> None:
        self.released = True


async def test_runs_a_plan_through_its_ports_only() -> None:
    operations, journal, streams = FakeOperations(), FakeJournal(), FakeStreams()
    devices, execution = FakeDevices(), FakeExecution()
    finished: list[RunInterpreter] = []
    clock = itertools.count(100)
    ports = RunPorts(
        devices=devices,
        resolver=FakeResolver(),
        execution=execution,
        operations=operations,
        step_plugins={},
        journal=lambda run_id: journal,
        streams=lambda run_id, emit: streams,  # type: ignore[arg-type, return-value]
        published=lambda run, event: None,
        finished=finished.append,
        clock=lambda: float(next(clock)),
    )
    plan = {
        "id": "P",
        "revision": "r1",
        "regions": {
            "prepare": [{"id": "limit", "type": "SetVariable", "variable": "limit", "value": 5}],
            "test": [
                {
                    "id": "read",
                    "type": "InvokeTool",
                    "hardwareId": "H",
                    "toolName": "read",
                    "arguments": {"channel": {"expression": "variables.limit"}},
                    "assertions": [{"metric": "result.value", "op": "lt", "value": 5}],
                }
            ],
            "cleanup": [],
        },
    }
    run = RunInterpreter(ports, plan, {})
    await run.execute()

    assert run.state == "completed" and run.verdict == "Pass"
    assert devices.calls == [
        (
            "H.read",
            {"channel": 5},
            {"envelope": True, "operationId": run.last_operation_id},
        )
    ]
    assert streams.started == ["H"]
    assert streams.stopped and execution.released
    assert journal.plan == plan and journal.summary is not None
    assert journal.summary["verdict"] == "Pass"
    assert [item["kind"] for item in journal.results] == ["verdict"]
    assert [event["type"] for event in journal.events][:2] == ["run.started", "region.started"]
    assert journal.events[-1]["type"] == "run.completed"
    assert [item["state"] for item in operations.items.values()] == ["succeeded"]
    assert finished == [run]
    await asyncio.sleep(0)


async def test_an_aborted_run_drives_actuated_hardware_safe() -> None:
    operations, journal, streams = FakeOperations(), FakeJournal(), FakeStreams()
    blocked = asyncio.Event()

    class BlockingDevices(FakeDevices):
        async def call_aggregated_tool(
            self, name: str, arguments: Record, options: Record
        ) -> Record:
            self.calls.append((name, arguments, options))
            if name == "H.wait":
                blocked.set()
                await asyncio.sleep(10)
            return {"data": {}, "meta": {}}

    class SafetyResolver(FakeResolver):
        def resolve(self, hardware_id: str, tool_name: str) -> tuple[Record, list[Record]]:
            semantics: dict[str, Record] = {
                "set": {"kind": "actuate", "safetyAction": {"toolName": "safe_state"}},
                "safe_state": {"kind": "safe"},
            }
            return {
                "externalName": f"{hardware_id}.{tool_name}",
                "operationSemantics": semantics.get(tool_name, {}),
            }, []

    devices = BlockingDevices()
    ports = RunPorts(
        devices=devices,
        resolver=SafetyResolver(),
        execution=FakeExecution(),
        operations=operations,
        step_plugins={},
        journal=lambda run_id: journal,
        streams=lambda run_id, emit: streams,  # type: ignore[arg-type, return-value]
        published=lambda run, event: None,
        finished=lambda run: None,
        clock=lambda: 0.0,
    )
    plan = {
        "id": "P",
        "revision": "r1",
        "regions": {
            "prepare": [],
            "test": [
                {"id": "on", "type": "InvokeTool", "hardwareId": "H", "toolName": "set"},
                {"id": "hold", "type": "InvokeTool", "hardwareId": "H", "toolName": "wait"},
            ],
            "cleanup": [],
        },
    }
    run = RunInterpreter(ports, plan, {})
    task = asyncio.create_task(run.execute())
    await asyncio.wait_for(blocked.wait(), 5)
    run.request_abort()
    await asyncio.wait_for(task, 5)

    assert run.state == "aborted" and run.verdict == "Aborted"
    assert [name for name, _, _ in devices.calls] == ["H.set", "H.wait", "H.safe_state"]
    assert run.safety_status == "Verified"
