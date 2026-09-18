from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import logging
import re
import time
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator
from ruamel.yaml import YAML

from hardwareharness_backend.compat import clone, new_uuid, utc_now_iso
from hardwareharness_backend.contracts.errors import app_error, to_wire_error

from .expression import evaluate
from .models import aggregate_verdict, plan_hardware_ids
from .runtime_state import RuntimeStateStore, payload_hash

Record = dict[str, Any]
_EXPRESSION_STEP = re.compile(r"\bsteps\.([A-Za-z][A-Za-z0-9_-]{0,63})\b")


def _expression_step_id(value: Any) -> str | None:
    match = _EXPRESSION_STEP.search(value) if isinstance(value, str) else None
    return match.group(1) if match else None


class _AbortRun(Exception):
    pass


class _StopRegion(Exception):
    pass


class _PluginExecutionContext:
    """Narrow plugin surface that does not expose application or engine services."""

    __slots__ = ("__run",)

    def __init__(self, run: _Run) -> None:
        self.__run = run

    async def invoke_device(
        self, hardware_id: str, tool_name: str, arguments: Record, timeout_ms: int
    ) -> Any:
        return await self.__run.invoke_device(hardware_id, tool_name, arguments, timeout_ms)

    def publish_result(self, result: Record) -> None:
        self.__run.publish_result(result)

    async def checkpoint(self) -> None:
        await self.__run.checkpoint()


class TestEngine:
    __test__ = False

    def __init__(
        self,
        projects: Any,
        devices: Any,
        resolver: Any,
        execution: Any,
        step_plugins: list[Any] | None = None,
        listeners: list[Any] | None = None,
        runtime_state: RuntimeStateStore | None = None,
    ) -> None:
        self.projects, self.devices, self.resolver, self.execution = (
            projects,
            devices,
            resolver,
            execution,
        )
        self.listeners = listeners or []
        self.runtime = runtime_state or RuntimeStateStore(projects)
        self.step_plugins = {plugin.type_name: plugin for plugin in (step_plugins or [])}
        self.runs: dict[str, _Run] = {}
        self.active: _Run | None = None
        self.notifier: Any = None

    def set_notifier(self, notifier: Any) -> None:
        self.notifier = notifier

    async def start(
        self, plan: Record, parameters: Record, execution_revision: str | None = None
    ) -> Record:
        if self.active and not self.active.done:
            raise app_error(
                "conflict", "A test plan is already running", {"runId": self.active.run_id}
            )
        self.runtime.initialize()
        blocked = {
            item["hardwareId"] for item in self.runtime.operations(recovery_only=True)
        } & set(plan_hardware_ids(plan))
        if blocked:
            raise app_error(
                "conflict",
                "Hardware has unresolved physical operations",
                {"hardwareIds": sorted(blocked), "recoveryRequired": True},
            )
        run = _Run(self, plan, parameters, execution_revision)
        self.runs[run.run_id] = run
        self.active = run
        run.task = asyncio.create_task(run.execute())
        await run.started.wait()
        if run.start_error:
            self.active = None
            raise run.start_error
        return run.snapshot()

    def get(self, run_id: str | None = None) -> Record | None:
        run = self.runs.get(run_id) if run_id else self.active
        if run:
            return run.snapshot()
        return self.runtime.load_run(run_id) if run_id else None

    def current(self) -> Record | None:
        if self.active:
            return self.active.snapshot()
        latest = next(reversed(self.runs.values()), None) if self.runs else None
        return latest.snapshot() if latest else self.runtime.latest_run()

    async def pause(self, run_id: str) -> Record:
        run = self._require(run_id)
        run.pause_requested = True
        run.pause_gate.clear()
        run.emit("run.pauseRequested", {})
        return run.snapshot()

    async def resume(self, run_id: str) -> Record:
        run = self._require(run_id)
        run.pause_requested = False
        run.pause_gate.set()
        run.emit("run.resumed", {})
        return run.snapshot()

    async def abort(self, run_id: str) -> Record:
        run = self._require(run_id)
        run.abort_requested = True
        run.pause_gate.set()
        for task in list(run.hardware_tasks):
            task.cancel()
        run.emit("run.abortRequested", {})
        return run.snapshot()

    async def wait(self, run_id: str, after_sequence: int = 0, timeout_ms: int = 30_000) -> Record:
        run = self.runs.get(run_id)
        if not run:
            snapshot = self.runtime.load_run(run_id)
            if not snapshot:
                raise app_error("not_found", f"Test run not found: {run_id}")
            return {
                "run": snapshot,
                "events": self._read_artifact_jsonl(run_id, "events.jsonl", after_sequence),
            }
        timeout = min(max(timeout_ms, 1), 30_000) / 1000
        async with run.changed:
            if not run.done and not any(event["sequence"] > after_sequence for event in run.events):
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(run.changed.wait(), timeout)
        return {
            "run": run.snapshot(),
            "events": [clone(event) for event in run.events if event["sequence"] > after_sequence],
        }

    def read_results(self, run_id: str, after_sequence: int = 0) -> Record:
        run = self.runs.get(run_id)
        if not run:
            if not self.runtime.load_run(run_id):
                raise app_error("not_found", f"Test run not found: {run_id}")
            results = self._read_artifact_jsonl(run_id, "results.jsonl", after_sequence)
            return {
                "runId": run_id,
                "results": results,
                "nextSequence": max(
                    (int(item.get("sequence", 0)) for item in results),
                    default=after_sequence,
                ),
            }
        return {
            "runId": run_id,
            "results": [clone(item) for item in run.results if item["sequence"] > after_sequence],
            "nextSequence": run.result_sequence,
        }

    def read_log(
        self,
        run_id: str,
        after_event_sequence: int = 0,
        after_result_sequence: int = 0,
        event_limit: int = 1000,
        result_limit: int = 1000,
    ) -> Record:
        run = self.runs.get(run_id)
        snapshot = run.snapshot() if run else self.runtime.load_run(run_id)
        if not snapshot:
            raise app_error("not_found", f"Test run not found: {run_id}")
        all_events = (
            [clone(item) for item in run.events if item["sequence"] > after_event_sequence]
            if run
            else self._read_artifact_jsonl(run_id, "events.jsonl", after_event_sequence)
        )
        all_results = (
            [clone(item) for item in run.results if item["sequence"] > after_result_sequence]
            if run
            else self._read_artifact_jsonl(run_id, "results.jsonl", after_result_sequence)
        )
        bounded_event_limit = min(max(int(event_limit), 1), 5000)
        bounded_result_limit = min(max(int(result_limit), 1), 5000)
        events = all_events[:bounded_event_limit]
        results = all_results[:bounded_result_limit]
        latest_event_sequence = int(snapshot.get("sequence", 0))
        latest_result_sequence = int(snapshot.get("resultSequence", 0))
        next_event_sequence = max(
            (int(item.get("sequence", 0)) for item in events), default=after_event_sequence
        )
        next_result_sequence = max(
            (int(item.get("sequence", 0)) for item in results), default=after_result_sequence
        )
        return {
            "run": self.runtime.normalize_run(snapshot),
            "plan": self._read_plan_snapshot(run_id),
            "events": events,
            "results": results,
            "nextEventSequence": next_event_sequence,
            "nextResultSequence": next_result_sequence,
            "latestEventSequence": latest_event_sequence,
            "latestResultSequence": latest_result_sequence,
            "hasMoreEvents": next_event_sequence < latest_event_sequence,
            "hasMoreResults": next_result_sequence < latest_result_sequence,
        }

    def reconcile_run(self, run_id: str, operation_id: str, resolution: str) -> Record:
        active = self.runs.get(run_id)
        if active and not active.done:
            raise app_error("conflict", "Cannot reconcile an operation while its run is active")
        snapshot = self.runtime.load_run(run_id)
        if not snapshot:
            raise app_error("not_found", f"Test run not found: {run_id}")
        operations = self.runtime.operations(run_id)
        snapshot["operations"] = operations
        snapshot["outcomeKnown"] = all(item.get("outcomeKnown", True) for item in operations)
        snapshot["recoveryRequired"] = any(
            item.get("recoveryRequired", False) for item in operations
        )
        primary = snapshot.get("primaryError")
        if not snapshot["recoveryRequired"]:
            if resolution == "safe_state_restored":
                snapshot["safetyStatus"] = "Verified"
                if isinstance(primary, dict) and primary.get("phase") in {
                    "cleanup",
                    "safety",
                }:
                    primary["recovered"] = True
                    if snapshot.get("cleanupStatus") in {"Failed", "Unknown"}:
                        snapshot["cleanupStatus"] = "Recovered"
                    if snapshot.get("verdict") != "Error":
                        snapshot["executionStatus"] = "Succeeded"
                        if snapshot.get("state") == "error":
                            snapshot["state"] = "completed"
            elif snapshot.get("safetyStatus") == "Unknown" and snapshot["outcomeKnown"]:
                snapshot["safetyStatus"] = "NotRequired"
        sequence = int(snapshot.get("sequence", 0)) + 1
        snapshot["sequence"] = sequence
        event = {
            "sequence": sequence,
            "at": utc_now_iso(),
            "runId": run_id,
            "type": "operation.reconciled",
            "operationId": operation_id,
            "resolution": resolution,
            "recoveryRequired": snapshot["recoveryRequired"],
            "safetyStatus": snapshot.get("safetyStatus"),
        }
        self.runtime.save_run(snapshot)
        session = self.projects.session()
        if session:
            run_dir = Path(session["rootPath"]) / ".hardwareharness" / "runs" / run_id
            if run_dir.exists():
                with (run_dir / "events.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
                (run_dir / "summary.json").write_text(
                    json.dumps(snapshot, ensure_ascii=False, indent=2, default=str) + "\n",
                    encoding="utf-8",
                )
        if self.notifier:
            self.notifier(
                {
                    "runId": run_id,
                    "eventSequence": sequence,
                    "resultSequence": int(snapshot.get("resultSequence", 0)),
                    "state": snapshot.get("state"),
                }
            )
        return self.runtime.normalize_run(snapshot)

    def _read_plan_snapshot(self, run_id: str) -> Record:
        session = self.projects.session()
        if not session:
            raise app_error("requires_project", "requires_project")
        path = Path(session["rootPath"]) / ".hardwareharness" / "runs" / run_id / "plan.hhplan.yaml"
        if not path.exists():
            return {
                "id": "unknown",
                "name": "历史测试计划",
                "regions": {"prepare": [], "test": [], "cleanup": []},
            }
        yaml = YAML(typ="safe")
        value = yaml.load(path.read_text(encoding="utf-8"))
        return (
            clone(value)
            if isinstance(value, dict)
            else {"regions": {"prepare": [], "test": [], "cleanup": []}}
        )

    def _read_artifact_jsonl(self, run_id: str, name: str, after_sequence: int) -> list[Record]:
        session = self.projects.session()
        if not session:
            raise app_error("requires_project", "requires_project")
        path = Path(session["rootPath"]) / ".hardwareharness" / "runs" / run_id / name
        if not path.exists():
            return []
        output: list[Record] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            with contextlib.suppress(json.JSONDecodeError):
                item = json.loads(line)
                if isinstance(item, dict) and int(item.get("sequence", 0)) > after_sequence:
                    output.append(item)
        return output

    def _require(self, run_id: str) -> _Run:
        run = self.runs.get(run_id)
        if not run:
            raise app_error("not_found", f"Test run not found: {run_id}")
        return run

    def _published(self, run: _Run, event: Record) -> None:
        for listener in self.listeners:
            try:
                listener.on_event(clone(event))
            except Exception:
                logging.exception("Test result listener failed")
        if self.notifier:
            self.notifier(
                {
                    "runId": run.run_id,
                    "eventSequence": run.sequence,
                    "resultSequence": run.result_sequence,
                    "state": run.state,
                }
            )


class _Run:
    def __init__(
        self,
        engine: TestEngine,
        plan: Record,
        parameters: Record,
        execution_revision: str | None = None,
    ) -> None:
        self.engine, self.plan, self.parameters = engine, clone(plan), clone(parameters)
        self.run_id = new_uuid()
        self.state = "starting"
        self.verdict = "NotSet"
        self.execution_status = "Running"
        self.started_at = utc_now_iso()
        self.completed_at: str | None = None
        self.execution_revision = execution_revision
        self.cleanup_status = "NotRequired"
        self.safety_status = "NotRequired"
        self.primary_error: Record | None = None
        self.outcome_known = True
        self.recovery_required = False
        self.safety_actions: list[Record] = []
        self.cleanup_had_error = False
        self.current_phase = "startup"
        self.last_operation_id: str | None = None
        self.sequence = 0
        self.result_sequence = 0
        self.events: list[Record] = []
        self.results: list[Record] = []
        self.variables: Record = {}
        self.outputs: Record = {}
        self.last_execution_by_step_id: dict[str, str] = {}
        self.execution_context: contextvars.ContextVar[Record | None] = contextvars.ContextVar(
            f"hardwareharness_test_execution_{self.run_id}", default=None
        )
        self.active_executions: dict[str, str] = {}
        self.item: Any = None
        self.index = 0
        self.pause_requested = False
        self.abort_requested = False
        self.pause_gate = asyncio.Event()
        self.pause_gate.set()
        self.changed = asyncio.Condition()
        self.started = asyncio.Event()
        self.start_error: Exception | None = None
        self.task: asyncio.Task[None] | None = None
        self.hardware_tasks: set[asyncio.Task[Any]] = set()
        self.hardware_locks: dict[str, asyncio.Lock] = {}
        self.activity_handle: Any = None
        self.run_dir = self._run_directory()

    @property
    def done(self) -> bool:
        return self.state in {"completed", "aborted", "error"}

    def snapshot(self) -> Record:
        active_execution_ids = list(self.active_executions)
        current_step_id = (
            self.active_executions[active_execution_ids[-1]]
            if active_execution_ids
            else self.variables.get("__currentStepId")
        )
        return {
            "runId": self.run_id,
            "planId": self.plan["id"],
            "revision": self.plan["revision"],
            "executionRevision": self.execution_revision,
            "planName": self.plan.get("name", ""),
            "state": self.state,
            "verdict": self.verdict,
            "executionStatus": self.execution_status,
            "startedAt": self.started_at,
            **({"completedAt": self.completed_at} if self.completed_at else {}),
            "sequence": self.sequence,
            "resultSequence": self.result_sequence,
            "currentStepId": current_step_id,
            "activeExecutionIds": active_execution_ids,
            "pauseRequested": self.pause_requested,
            "abortRequested": self.abort_requested,
            "hardwareIds": plan_hardware_ids(self.plan),
            "cleanupStatus": self.cleanup_status,
            "safetyStatus": self.safety_status,
            "outcomeKnown": self.outcome_known,
            "recoveryRequired": self.recovery_required,
            **({"primaryError": clone(self.primary_error)} if self.primary_error else {}),
            "coverage": self._coverage_summary(),
            "operations": self.engine.runtime.operations(self.run_id),
        }

    async def execute(self) -> None:
        try:
            self.run_dir.mkdir(parents=True, exist_ok=False)
            self._write_yaml(self.run_dir / "plan.hhplan.yaml", self.plan)
            hardware_ids = plan_hardware_ids(self.plan)
            self.activity_handle = self.engine.execution.acquire(
                {
                    "state": "run",
                    "runId": self.run_id,
                    "planId": self.plan["id"],
                    "revision": self.plan["revision"],
                    "hardwareIds": hardware_ids,
                    "startedAt": self.started_at,
                }
            )
            self.state = "running"
            self.execution_status = "Running"
            self.emit("run.started", {"parameters": self.parameters})
            self.engine.runtime.save_run(self.snapshot())
            self.started.set()
            await self._region("prepare", self.plan["regions"]["prepare"])
            if self.abort_requested:
                raise _AbortRun()
            if self.verdict != "Error":
                await self._region("test", self.plan["regions"]["test"])
        except _AbortRun:
            self.verdict = aggregate_verdict(self.verdict, "Aborted")
            self.execution_status = "Aborted"
        except Exception as error:
            if not self.started.is_set():
                self.start_error = error
                self.started.set()
            self.verdict = aggregate_verdict(self.verdict, "Error")
            self.execution_status = "Failed"
            self._record_primary_error(error, phase="startup")
            self.emit("run.error", {"error": to_wire_error(error)})
        finally:
            if self.started.is_set() and self.start_error is None:
                self.state = "cleaning"
                self.current_phase = "cleanup"
                self.emit("run.cleanupStarted", {})
                has_cleanup = bool(self.plan["regions"]["cleanup"])
                self.cleanup_status = "Succeeded" if has_cleanup else "NotRequired"
                self.safety_status = "Pending" if self.safety_actions else "NotRequired"
                try:
                    cleanup_verdict = await asyncio.wait_for(
                        self._region("cleanup", self.plan["regions"]["cleanup"], cleanup=True),
                        timeout=max(1, int(self.plan.get("cleanupTimeoutMs", 60_000))) / 1000,
                    )
                    if cleanup_verdict == "Error":
                        self.cleanup_had_error = True
                        self.cleanup_status = "Failed"
                    await self._run_safety_actions()
                    if self.safety_status == "Pending":
                        self.safety_status = "Verified"
                    if self.cleanup_had_error and self.safety_status == "Verified":
                        self.cleanup_status = "Recovered"
                        if self.primary_error and self.primary_error.get("phase") == "cleanup":
                            self.primary_error["recovered"] = True
                    elif self.cleanup_had_error:
                        self.cleanup_status = "Failed"
                        self.safety_status = (
                            "Unknown" if self.safety_status == "NotRequired" else self.safety_status
                        )
                        self.execution_status = "Failed"
                    self._refresh_operation_certainty()
                    self.emit(
                        "run.safetyVerified",
                        {"safe": self.safety_status in {"Verified", "NotRequired"}},
                    )
                except TimeoutError as error:
                    self.cleanup_status = "Unknown"
                    self.safety_status = "Unknown"
                    self.outcome_known = False
                    self.recovery_required = True
                    self.execution_status = "Failed"
                    self._record_primary_error(error, phase="cleanup")
                    self.emit(
                        "run.cleanupError", {"error": to_wire_error(error), "outcomeKnown": False}
                    )
                except Exception as error:
                    self.cleanup_status = "Failed"
                    details = to_wire_error(error).get("details") or {}
                    self.safety_status = "Failed" if details.get("outcomeKnown") else "Unknown"
                    self.recovery_required = True
                    self.execution_status = "Failed"
                    self._record_primary_error(error, phase="safety")
                    self.emit("run.cleanupError", {"error": to_wire_error(error)})
                if self.activity_handle:
                    self.activity_handle.release()
                    self.activity_handle = None
                if self.verdict == "NotSet":
                    self.verdict = "Pass"
                if self.execution_status == "Running":
                    self.execution_status = "Succeeded"
                self.state = (
                    "aborted"
                    if self.execution_status == "Aborted"
                    else "error"
                    if self.execution_status == "Failed"
                    else "completed"
                )
                self.completed_at = utc_now_iso()
                self.emit(
                    "run.completed",
                    {
                        "verdict": self.verdict,
                        "executionStatus": self.execution_status,
                        "cleanupStatus": self.cleanup_status,
                        "safetyStatus": self.safety_status,
                    },
                )
                self.engine.runtime.save_run(self.snapshot())
                self._write_json(self.run_dir / "summary.json", self.snapshot())
                (self.run_dir / "run.log").write_text(self._format_log(), encoding="utf-8")
            if self.engine.active is self:
                self.engine.active = None

    async def _run_safety_actions(self) -> None:
        while self.safety_actions:
            action = self.safety_actions.pop()
            self.emit("safety.started", {"action": clone(action)})
            try:
                previous_operation_id = self.last_operation_id
                await self.invoke_device(
                    str(action["hardwareId"]),
                    str(action["toolName"]),
                    clone(action.get("arguments", {})),
                    int(action.get("timeoutMs", 10_000)),
                    cleanup=True,
                )
            except Exception:
                self.safety_actions.append(action)
                raise
            if self.last_operation_id and self.last_operation_id != previous_operation_id:
                self._resolve_hardware_recovery(str(action["hardwareId"]), self.last_operation_id)
            self.emit("safety.completed", {"action": clone(action)})

    async def _region(self, name: str, steps: list[Record], cleanup: bool = False) -> str:
        self.current_phase = name
        self.emit("region.started", {"region": name})
        verdict = "NotSet"
        with contextlib.suppress(_StopRegion):
            verdict = await self._steps(
                steps, cleanup=cleanup, stop_on_fail=bool(self.plan.get("stopOnFail"))
            )
        self.emit("region.completed", {"region": name})
        return verdict

    async def _steps(
        self,
        steps: list[Record],
        cleanup: bool = False,
        stop_on_fail: bool = False,
        *,
        parent_execution_id: str | None = None,
        branch: str | None = None,
        branch_index: int | None = None,
        iteration_index: int | None = None,
        iteration_count: int | None = None,
        attempt_index: int | None = None,
        attempt_count: int | None = None,
    ) -> str:
        verdict = "NotSet"
        for step in steps:
            execution_fields = self._execution_fields(
                new_uuid(),
                parent_execution_id=parent_execution_id,
                branch=branch,
                branch_index=branch_index,
                iteration_index=iteration_index,
                iteration_count=iteration_count,
                attempt_index=attempt_index,
                attempt_count=attempt_count,
            )
            if not step.get("enabled", True):
                self.emit(
                    "step.skipped",
                    {
                        "stepId": step.get("id"),
                        "stepType": step.get("type"),
                        "reason": "disabled",
                        **execution_fields,
                    },
                )
                continue
            result = await self._step(step, cleanup, execution_fields=execution_fields)
            verdict = aggregate_verdict(verdict, result)
            if not cleanup:
                self.verdict = aggregate_verdict(self.verdict, result)
            if result == "Error" and not cleanup:
                raise _StopRegion()
            if result == "Fail" and (stop_on_fail or step.get("stopOnFail")):
                raise _StopRegion()
        return verdict

    async def _step(
        self,
        step: Record,
        cleanup: bool,
        *,
        execution_fields: Record | None = None,
    ) -> str:
        if not cleanup:
            await self.checkpoint()
        step_id, step_type = step["id"], step["type"]
        fields = execution_fields or self._execution_fields(new_uuid())
        execution_id = str(fields["executionId"])
        context = {"stepId": step_id, "stepType": step_type, **fields}
        token = self.execution_context.set(context)
        self.active_executions[execution_id] = step_id
        self.variables["__currentStepId"] = step_id
        started = time.monotonic()
        self.emit("step.started", context)
        verdict = "Pass"
        output: Any = None
        outcome_known = True
        try:
            output, verdict = await self._execute_step(step, cleanup, execution_id)
        except _AbortRun:
            verdict = "Aborted"
            outcome_known = not bool(self.hardware_tasks)
            raise
        except asyncio.CancelledError as error:
            verdict, outcome_known = "Aborted", False
            raise _AbortRun() from error
        except Exception as error:
            if self.abort_requested:
                verdict, outcome_known = "Aborted", False
                raise _AbortRun() from error
            verdict = "Error"
            details = to_wire_error(error)
            outcome_known = bool((details.get("details") or {}).get("outcomeKnown", True))
            if not outcome_known:
                self.variables["__unknownOutcome"] = True
            output = {"error": details}
            if cleanup:
                self.cleanup_had_error = True
                self._record_primary_error(error, phase="cleanup", step=step)
            else:
                self.execution_status = "Failed"
                self._record_primary_error(error, phase=self.current_phase, step=step)
            if step.get("errorPolicy") == "fail" and outcome_known:
                verdict = "Fail"
                output["handledAs"] = "Fail"
        finally:
            duration_ms = int((time.monotonic() - started) * 1000)
            if output is not None:
                self.outputs[step_id] = clone(output)
                self.last_execution_by_step_id[step_id] = execution_id
            event = {
                "stepId": step_id,
                "stepType": step_type,
                **fields,
                "verdict": verdict,
                "durationMs": duration_ms,
                "outcomeKnown": outcome_known,
                "output": output,
            }
            self.active_executions.pop(execution_id, None)
            self.emit("step.completed", event)
            self.execution_context.reset(token)
        return verdict

    async def _execute_step(
        self, step: Record, cleanup: bool, execution_id: str
    ) -> tuple[Any, str]:
        kind = step["type"]
        if kind in {"Sequence", "Group"}:
            return None, await self._steps(
                step.get("children", []),
                cleanup,
                bool(step.get("stopOnFail")),
                parent_execution_id=execution_id,
                branch="children",
            )
        if kind == "If":
            selected_branch = (
                "children" if bool(self.expr(step.get("condition", "false"))) else "elseChildren"
            )
            self.emit(
                "control.branch.selected",
                {"executionId": execution_id, "selectedBranch": selected_branch},
            )
            return None, await self._steps(
                step.get(selected_branch, []),
                cleanup,
                bool(step.get("stopOnFail")),
                parent_execution_id=execution_id,
                branch=selected_branch,
            )
        if kind == "Repeat":
            repeat_verdict = "NotSet"
            count = max(
                0, min(int(self.value(step, "count", 1)), int(step.get("maxIterations", 10_000)))
            )
            for self.index in range(count):
                self.emit(
                    "loop.iteration.started",
                    {
                        "executionId": execution_id,
                        "iterationIndex": self.index,
                        "iterationCount": count,
                    },
                )
                iteration_verdict = "Error"
                try:
                    iteration_verdict = await self._steps(
                        step.get("children", []),
                        cleanup,
                        bool(step.get("stopOnFail")),
                        parent_execution_id=execution_id,
                        branch="children",
                        iteration_index=self.index,
                        iteration_count=count,
                    )
                    repeat_verdict = aggregate_verdict(repeat_verdict, iteration_verdict)
                except _AbortRun:
                    iteration_verdict = "Aborted"
                    raise
                finally:
                    self.emit(
                        "loop.iteration.completed",
                        {
                            "executionId": execution_id,
                            "iterationIndex": self.index,
                            "iterationCount": count,
                            "verdict": iteration_verdict,
                        },
                    )
            return {"iterations": count}, repeat_verdict
        if kind == "ForEach":
            items = list(self.value(step, "items", []))
            foreach_verdict = "NotSet"
            previous_item, previous_index = self.item, self.index
            bounded_items = items[: int(step.get("maxIterations", 10_000))]
            for self.index, self.item in enumerate(bounded_items):
                self.emit(
                    "loop.iteration.started",
                    {
                        "executionId": execution_id,
                        "iterationIndex": self.index,
                        "iterationCount": len(bounded_items),
                    },
                )
                iteration_verdict = "Error"
                try:
                    iteration_verdict = await self._steps(
                        step.get("children", []),
                        cleanup,
                        bool(step.get("stopOnFail")),
                        parent_execution_id=execution_id,
                        branch="children",
                        iteration_index=self.index,
                        iteration_count=len(bounded_items),
                    )
                    foreach_verdict = aggregate_verdict(foreach_verdict, iteration_verdict)
                except _AbortRun:
                    iteration_verdict = "Aborted"
                    raise
                finally:
                    self.emit(
                        "loop.iteration.completed",
                        {
                            "executionId": execution_id,
                            "iterationIndex": self.index,
                            "iterationCount": len(bounded_items),
                            "verdict": iteration_verdict,
                        },
                    )
            self.item, self.index = previous_item, previous_index
            return {"iterations": len(bounded_items)}, foreach_verdict
        if kind == "Parallel":
            results = await asyncio.gather(
                *(
                    self._step(
                        child,
                        cleanup,
                        execution_fields=self._execution_fields(
                            new_uuid(),
                            parent_execution_id=execution_id,
                            branch="children",
                            branch_index=index,
                        ),
                    )
                    for index, child in enumerate(step.get("children", []))
                )
            )
            verdict = "NotSet"
            for result in results:
                verdict = aggregate_verdict(verdict, result)
            return None, verdict
        if kind == "Retry":
            attempts = max(1, min(int(step.get("attempts", 1)), 20))
            last = "Error"
            for attempt in range(attempts):
                self.emit(
                    "retry.attempt.started",
                    {
                        "executionId": execution_id,
                        "attemptIndex": attempt,
                        "attemptCount": attempts,
                    },
                )
                try:
                    last = await self._steps(
                        step.get("children", []),
                        cleanup,
                        bool(step.get("stopOnFail")),
                        parent_execution_id=execution_id,
                        branch="children",
                        attempt_index=attempt,
                        attempt_count=attempts,
                    )
                    self.emit(
                        "retry.attempt.completed",
                        {
                            "executionId": execution_id,
                            "attemptIndex": attempt,
                            "attemptCount": attempts,
                            "verdict": last,
                        },
                    )
                    if last not in {"Error", "Fail"}:
                        return {"attempts": attempt + 1}, last
                except _StopRegion:
                    last = "Error"
                    self.emit(
                        "retry.attempt.completed",
                        {
                            "executionId": execution_id,
                            "attemptIndex": attempt,
                            "attemptCount": attempts,
                            "verdict": last,
                        },
                    )
                if self.variables.pop("__unknownOutcome", False):
                    return {"attempts": attempt + 1, "outcomeKnown": False}, "Error"
                if attempt + 1 < attempts:
                    await asyncio.sleep(max(0, int(step.get("delayMs", 0))) / 1000)
            return {"attempts": attempts}, last
        if kind == "SetVariable":
            value = self.value(step, "value")
            self.variables[str(step["variable"])] = value
            return value, "Pass"
        if kind == "Evaluate":
            return self.expr(str(step.get("expression", "null"))), "Pass"
        if kind == "Delay":
            await self.cooperative_sleep(
                max(0, int(self.value(step, "durationMs", 0))) / 1000, cleanup
            )
            return None, "Pass"
        if kind == "WaitUntil":
            deadline = time.monotonic() + max(1, int(step.get("timeoutMs", 30_000))) / 1000
            while not bool(self.expr(str(step.get("condition", "false")))):
                if time.monotonic() >= deadline:
                    raise TimeoutError("WaitUntil timed out")
                await self.cooperative_sleep(
                    max(10, int(step.get("pollIntervalMs", 100))) / 1000, cleanup
                )
            return True, "Pass"
        if kind == "InvokeTool":
            arguments = self.bind(step.get("arguments", {}))
            binding = self.plan.get("resolvedBindings", {}).get(step["id"])
            output = await self.invoke_device(
                step["hardwareId"],
                step["toolName"],
                arguments,
                int(step.get("timeoutMs", 30_000)),
                binding=binding,
                cleanup=cleanup,
            )
            semantics = (binding or {}).get("operationSemantics", {})
            if semantics.get("evidenceType") == "measurement":
                measured_value = (
                    output.get("volts")
                    if isinstance(output, dict) and "volts" in output
                    else clone(output)
                )
                self.publish_result(
                    {
                        "kind": "measurement",
                        "name": step.get("name", step["id"]),
                        "value": measured_value,
                        "raw": clone(output),
                        "unit": "V"
                        if isinstance(output, dict) and "volts" in output
                        else step.get("unit"),
                        "sourceStepId": step["id"],
                        "hardwareId": step["hardwareId"],
                        "toolName": step["toolName"],
                        "evidenceType": "measurement",
                    }
                )
            elif str(semantics.get("evidenceType", "")).startswith("firmware_"):
                firmware = output.get("firmware", {}) if isinstance(output, dict) else {}
                result = output.get("result", {}) if isinstance(output, dict) else {}
                self.publish_result(
                    {
                        "kind": "observation",
                        "name": step.get("name", step["id"]),
                        "value": clone(output),
                        "sourceStepId": step["id"],
                        "hardwareId": step["hardwareId"],
                        "toolName": step["toolName"],
                        "evidenceType": semantics["evidenceType"],
                        "firmware": {
                            "sha256": arguments.get("expected_sha256") or firmware.get("sha256"),
                            "targetHardwareId": arguments.get("hardwareId") or step["hardwareId"],
                            "jobId": output.get("jobId") if isinstance(output, dict) else None,
                            "operation": output.get("operation")
                            if isinstance(output, dict)
                            else None,
                            "state": output.get("state") if isinstance(output, dict) else None,
                            "verified": result.get("verified")
                            if isinstance(result, dict)
                            else None,
                        },
                    }
                )
            return output, "Pass"
        if kind in {"Equal", "Range", "Tolerance", "Bitmask"}:
            actual = self.value(step, "actual")
            if kind == "Equal":
                passed = actual == self.value(step, "expected")
            elif kind == "Range":
                passed = self.value(step, "minimum") <= actual <= self.value(step, "maximum")
            elif kind == "Tolerance":
                passed = abs(actual - self.value(step, "expected")) <= self.value(
                    step, "tolerance", 0
                )
            else:
                mask = int(self.value(step, "mask"))
                passed = int(actual) & mask == int(self.value(step, "expected")) & mask
            assertion_result = {
                "kind": "assertion",
                "name": step.get("name", step["id"]),
                "actual": actual,
                "passed": passed,
                "limits": {
                    key: self.value(step, key)
                    for key in ("expected", "minimum", "maximum", "tolerance", "mask")
                    if key in step or key + "Expression" in step
                },
                "sourceStepId": step["id"],
                "requirementIds": clone(step.get("requirementIds", [])),
                "evidenceType": "assertion",
            }
            source = _expression_step_id(step.get("actualExpression"))
            if source:
                binding = self.plan.get("resolvedBindings", {}).get(source, {})
                assertion_result.update(
                    {
                        "sourceMeasurementStepId": source,
                        "hardwareId": binding.get("hardwareId"),
                        "toolName": binding.get("remoteName"),
                        **(
                            {"sourceMeasurementExecutionId": self.last_execution_by_step_id[source]}
                            if source in self.last_execution_by_step_id
                            else {}
                        ),
                    }
                )
            if "unit" in step:
                assertion_result["unit"] = step["unit"]
            self.publish_result(assertion_result)
            return assertion_result, "Pass" if passed else "Fail"
        if kind == "PublishResult":
            published_result = {
                "kind": str(step.get("resultKind", "note")),
                "name": step.get("name", step["id"]),
                "value": self.value(step, "value"),
                "unit": step.get("unit"),
                "metadata": self.bind(step.get("metadata", {})),
                "sourceStepId": step["id"],
                "evidenceType": str(step.get("evidenceType", "note")),
            }
            self.publish_result(published_result)
            return published_result, str(step.get("verdict", "Pass"))
        plugin = self.engine.step_plugins.get(kind)
        if plugin:
            context = _PluginExecutionContext(self)
            await plugin.prepare(context, step)
            try:
                return await plugin.run(context, step), "Pass"
            finally:
                await plugin.cleanup(context, step)
        raise app_error("invalid_argument", f"No executor for step type {kind}")

    async def checkpoint(self) -> None:
        if self.abort_requested:
            raise _AbortRun()
        if self.pause_requested:
            if self.state != "paused":
                self.state = "paused"
                self.emit("run.paused", {})
            await self.pause_gate.wait()
            if self.abort_requested:
                raise _AbortRun()
            self.state = "running"

    async def cooperative_sleep(self, seconds: float, cleanup: bool) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not cleanup:
                await self.checkpoint()
            await asyncio.sleep(min(0.1, max(0, deadline - time.monotonic())))

    async def invoke_device(
        self,
        hardware_id: str,
        tool_name: str,
        arguments: Record,
        timeout_ms: int,
        *,
        binding: Record | None = None,
        cleanup: bool = False,
    ) -> Any:
        tool, issues = (
            (binding, []) if binding else self.engine.resolver.resolve(hardware_id, tool_name)
        )
        if not tool:
            raise app_error(
                "validation_failed", "Hardware tool binding is invalid", {"issues": issues}
            )
        lock = self.hardware_locks.setdefault(hardware_id, asyncio.Lock())
        async with lock:
            if not cleanup:
                await self.checkpoint()
            operation_id = new_uuid()
            self.last_operation_id = operation_id
            execution_context = self.execution_context.get()
            operation = {
                "operationId": operation_id,
                "runId": self.run_id,
                "hardwareId": hardware_id,
                "toolName": tool_name,
                "inputHash": payload_hash(arguments),
                "state": "accepted",
                "outcomeKnown": True,
                "recoveryRequired": False,
                **(
                    {
                        "stepId": str(execution_context["stepId"]),
                        "executionId": str(execution_context["executionId"]),
                    }
                    if execution_context
                    else {}
                ),
            }
            self.engine.runtime.record_operation(operation)
            self.emit(
                "operation.accepted",
                {
                    "operation": {
                        key: value for key, value in operation.items() if key != "inputHash"
                    }
                },
            )
            task = asyncio.create_task(
                self.engine.devices.call_aggregated_tool(tool["externalName"], arguments)
            )
            self.engine.runtime.update_operation(operation_id, state="dispatched")
            self.emit(
                "operation.dispatched",
                {
                    "operationId": operation_id,
                    **self._current_execution_reference(),
                },
            )
            self.hardware_tasks.add(task)
            try:
                output = await asyncio.wait_for(task, timeout=max(1, timeout_ms) / 1000)
                output_schema = tool.get(
                    "resultSchema",
                    tool.get("outputSchema", tool.get("upstreamOutputSchema", {})),
                )
                if output_schema:
                    errors = list(Draft202012Validator(output_schema).iter_errors(output))
                    if errors:
                        raise app_error(
                            "invalid_response",
                            f"Hardware tool output failed schema validation: {errors[0].message}",
                            {
                                "outcomeKnown": False,
                                "recoveryRequired": True,
                                "operationId": operation_id,
                                "toolName": tool_name,
                            },
                        )
                self.engine.runtime.update_operation(
                    operation_id,
                    state="succeeded",
                    outcomeKnown=True,
                    recoveryRequired=False,
                    result=output,
                )
                semantics = tool.get("operationSemantics", {})
                safety = semantics.get("safetyAction")
                if isinstance(safety, dict) and not cleanup:
                    self.safety_actions.append({"hardwareId": hardware_id, **clone(safety)})
                if semantics.get("kind") == "safe":
                    self.safety_actions = [
                        item
                        for item in self.safety_actions
                        if item.get("hardwareId") != hardware_id
                    ]
                    if cleanup:
                        self._resolve_hardware_recovery(hardware_id, operation_id)
                self.emit(
                    "operation.succeeded",
                    {
                        "operationId": operation_id,
                        **self._current_execution_reference(),
                    },
                )
                return output
            except TimeoutError as error:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                self._mark_unknown_operation(operation_id)
                raise app_error(
                    "unavailable",
                    "Hardware call timed out; physical outcome is unknown",
                    {
                        "outcomeKnown": False,
                        "automaticRetry": False,
                        "hardwareId": hardware_id,
                        "toolName": tool_name,
                        "operationId": operation_id,
                        "recoveryRequired": True,
                    },
                ) from error
            except asyncio.CancelledError as error:
                self._mark_unknown_operation(operation_id)
                raise app_error(
                    "cancelled",
                    "Hardware call cancelled; physical outcome is unknown",
                    {
                        "outcomeKnown": False,
                        "automaticRetry": False,
                        "hardwareId": hardware_id,
                        "toolName": tool_name,
                        "operationId": operation_id,
                        "recoveryRequired": True,
                    },
                ) from error
            except Exception as error:
                details = to_wire_error(error).get("details") or {}
                known = bool(details.get("outcomeKnown", False))
                self.engine.runtime.update_operation(
                    operation_id,
                    state="failed" if known else "outcome_unknown",
                    outcomeKnown=known,
                    recoveryRequired=not known,
                    result={"error": to_wire_error(error)},
                )
                if not known:
                    self.outcome_known = False
                    self.recovery_required = True
                raise
            finally:
                self.hardware_tasks.discard(task)

    def _mark_unknown_operation(self, operation_id: str) -> None:
        self.outcome_known = False
        self.recovery_required = True
        self.engine.runtime.update_operation(
            operation_id,
            state="outcome_unknown",
            outcomeKnown=False,
            recoveryRequired=True,
        )

    def _resolve_hardware_recovery(self, hardware_id: str, resolved_by: str) -> None:
        resolved_at = utc_now_iso()
        for operation in self.engine.runtime.operations(self.run_id, recovery_only=True):
            if operation["hardwareId"] != hardware_id or operation["operationId"] == resolved_by:
                continue
            self.engine.runtime.update_operation(
                operation["operationId"],
                recoveryRequired=False,
                resolvedByOperationId=resolved_by,
                resolvedAt=resolved_at,
            )
        if (
            self.primary_error
            and self.primary_error.get("hardwareId") == hardware_id
            and self.primary_error.get("phase") in {"cleanup", "safety"}
        ):
            self.primary_error["recovered"] = True

    def _refresh_operation_certainty(self) -> None:
        operations = self.engine.runtime.operations(self.run_id)
        self.outcome_known = all(item.get("outcomeKnown", True) for item in operations)
        self.recovery_required = any(item.get("recoveryRequired", False) for item in operations)

    def _record_primary_error(
        self, error: BaseException, *, phase: str, step: Record | None = None
    ) -> None:
        details = to_wire_error(error)
        metadata = (
            cast(Record, details.get("details")) if isinstance(details.get("details"), dict) else {}
        )
        if self.primary_error is None:
            self.primary_error = {
                "phase": phase
                if phase in {"prepare", "test", "cleanup", "safety", "startup"}
                else "startup",
                "category": str(details.get("category", "error")),
                "message": str(details.get("message", error)),
                "recovered": False,
                **({"stepId": str(step["id"])} if step and step.get("id") else {}),
                **(
                    {"hardwareId": str(step["hardwareId"])}
                    if step and step.get("hardwareId")
                    else {}
                ),
                **({"toolName": str(step["toolName"])} if step and step.get("toolName") else {}),
                **(
                    {"operationId": str(metadata["operationId"])}
                    if metadata.get("operationId")
                    else {"operationId": self.last_operation_id}
                    if self.last_operation_id
                    else {}
                ),
            }

    def expr(self, source: str) -> Any:
        return evaluate(
            source,
            {
                "parameters": self.parameters,
                "variables": self.variables,
                "steps": self.outputs,
                "item": self.item,
                "index": self.index,
            },
        )

    def value(self, step: Record, key: str, default: Any = None) -> Any:
        expression_key = key + "Expression"
        if expression_key in step:
            return self.expr(str(step[expression_key]))
        return self.bind(step.get(key, default))

    def bind(self, value: Any) -> Any:
        if isinstance(value, dict):
            if set(value) == {"expression"}:
                return self.expr(str(value["expression"]))
            return {key: self.bind(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.bind(item) for item in value]
        return value

    def publish_result(self, value: Record) -> None:
        self.result_sequence += 1
        result = {
            "sequence": self.result_sequence,
            "at": utc_now_iso(),
            **clone(value),
            **self._current_execution_reference(),
        }
        self.results.append(result)
        self._append_jsonl(self.run_dir / "results.jsonl", result)
        self.emit("result.published", {"result": result})

    def _coverage_summary(self) -> Record:
        requirements = {
            str(item.get("id")): item
            for item in self.plan.get("requirements", [])
            if isinstance(item, dict) and item.get("id")
        }
        output = []
        for identifier, requirement in requirements.items():
            assertions = [
                result
                for result in self.results
                if result.get("kind") == "assertion"
                and identifier in result.get("requirementIds", [])
            ]
            if not assertions:
                status = "NotRun"
            elif any(not result.get("passed", False) for result in assertions):
                status = "Failed"
            elif all(result.get("evidenceType") == "assertion" for result in assertions):
                status = "Passed"
            else:
                status = "InsufficientEvidence"
            output.append(
                {
                    "requirementId": identifier,
                    "name": requirement.get("name", identifier),
                    "status": status,
                    "evidenceCount": len(assertions),
                }
            )
        return {"requirements": output, "total": len(output)}

    def emit(self, kind: str, data: Record) -> None:
        self.sequence += 1
        event = {
            "sequence": self.sequence,
            "at": utc_now_iso(),
            "runId": self.run_id,
            "type": kind,
            **clone(data),
        }
        self.events.append(event)
        with contextlib.suppress(Exception):
            self.engine.runtime.save_run(self.snapshot())
        if self.run_dir.exists():
            self._append_jsonl(self.run_dir / "events.jsonl", event)
        self.engine._published(self, event)

        async def wake() -> None:
            async with self.changed:
                self.changed.notify_all()

        asyncio.create_task(wake())

    def _execution_fields(
        self,
        execution_id: str,
        *,
        parent_execution_id: str | None = None,
        branch: str | None = None,
        branch_index: int | None = None,
        iteration_index: int | None = None,
        iteration_count: int | None = None,
        attempt_index: int | None = None,
        attempt_count: int | None = None,
    ) -> Record:
        inherited = self.execution_context.get() or {}
        if iteration_index is None and isinstance(inherited.get("iterationIndex"), int):
            iteration_index = int(inherited["iterationIndex"])
        if iteration_count is None and isinstance(inherited.get("iterationCount"), int):
            iteration_count = int(inherited["iterationCount"])
        if attempt_index is None and isinstance(inherited.get("attemptIndex"), int):
            attempt_index = int(inherited["attemptIndex"])
        if attempt_count is None and isinstance(inherited.get("attemptCount"), int):
            attempt_count = int(inherited["attemptCount"])
        return {
            "executionId": execution_id,
            "region": self.current_phase,
            **({"parentExecutionId": parent_execution_id} if parent_execution_id else {}),
            **({"branch": branch} if branch else {}),
            **({"branchIndex": branch_index} if branch_index is not None else {}),
            **({"iterationIndex": iteration_index} if iteration_index is not None else {}),
            **({"iterationCount": iteration_count} if iteration_count is not None else {}),
            **({"attemptIndex": attempt_index} if attempt_index is not None else {}),
            **({"attemptCount": attempt_count} if attempt_count is not None else {}),
        }

    def _current_execution_reference(self) -> Record:
        context = self.execution_context.get()
        if not context:
            return {}
        return {
            "stepId": str(context["stepId"]),
            "executionId": str(context["executionId"]),
        }

    def _run_directory(self) -> Path:
        session = self.engine.projects.session()
        if not session:
            raise app_error("requires_project", "requires_project")
        return Path(session["rootPath"]) / ".hardwareharness" / "runs" / self.run_id

    def _format_log(self) -> str:
        def line(event: Record) -> str:
            details = {key: value for key, value in event.items() if key not in {"at", "type"}}
            encoded = json.dumps(details, ensure_ascii=False, default=str)
            return f"{event['at']} {event['type']} {encoded}"

        return "\n".join(line(event) for event in self.events) + "\n"

    @staticmethod
    def _write_json(path: Path, value: Any) -> None:
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8"
        )

    @staticmethod
    def _write_yaml(path: Path, value: Record) -> None:
        yaml = YAML(typ="rt")
        yaml.default_flow_style = False
        yaml.indent(mapping=2, sequence=4, offset=2)
        with path.open("w", encoding="utf-8", newline="\n") as stream:
            yaml.dump(value, stream)

    @staticmethod
    def _append_jsonl(path: Path, value: Any) -> None:
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, default=str) + "\n")
