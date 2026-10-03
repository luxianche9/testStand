"""The test interpreter (design doc §9.5): walks a compiled plan and executes its steps.

It performs no I/O of its own. Hardware calls, stream waits, the operation log and the
run journal all arrive through :class:`RunPorts`, so :class:`TestEngine` wires the real
implementations and simulation tests inject fakes.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
import time
from collections.abc import Callable, Coroutine, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar, cast

from jsonschema import Draft202012Validator

from hardwareharness_backend.contracts.errors import app_error, to_wire_error
from hardwareharness_backend.streams import judge
from hardwareharness_backend.streams.data import stream_key
from hardwareharness_backend.util import clone, new_uuid, utc_now_iso

from .expression import evaluate
from .manual import manual_options
from .models import (
    aggregate_verdict,
    finite,
    plan_hardware_ids,
    step_verdict,
)
from .protocols import PlanProtocols, encode_target

Record = dict[str, Any]
T = TypeVar("T")
LOGGER = logging.getLogger(__name__)


class OperationLog(Protocol):
    """Durable record of physical operations and run snapshots (crash recovery)."""

    def save_run(self, snapshot: Record) -> None: ...

    def record_operation(self, operation: Record) -> None: ...

    def update_operation(self, operation_id: str, **changes: Any) -> None: ...

    def operations(
        self, run_id: str | None = None, recovery_only: bool = False
    ) -> list[Record]: ...


class Journal(Protocol):
    """Where one run writes its plan snapshot, events, results and summary."""

    def create(self, plan: Record) -> None: ...

    def append_event(self, event: Record) -> None: ...

    def append_result(self, result: Record) -> None: ...

    def finish(self, summary: Record, events: list[Record]) -> None: ...


class GuardWatch(Protocol):
    def begin(self) -> bool: ...

    async def watch(self) -> Record | None: ...

    async def finish(self) -> tuple[Record, Record]: ...


class RunStreams(Protocol):
    """A run's device session: the stream recording, anchors and stream verdicts."""

    async def start(
        self, hardware_ids: list[str], protocols: PlanProtocols | None = None
    ) -> None: ...

    async def stop(self) -> None: ...

    def device_lock(self, hardware_id: str) -> asyncio.Lock:
        """The run's mutex for ``configure`` / ``actuate`` on one device."""
        ...

    def timing(
        self, hardware_id: str, backend_start: float, backend_end: float, meta: Record | None
    ) -> Record: ...

    def set_anchor(self, name: str, hardware_id: str, timing: Record) -> Record: ...

    async def observe(
        self,
        hardware_id: str,
        stream_id: str,
        window_spec: Record,
        assertions: list[Record],
        min_samples: int,
    ) -> tuple[Record, Record]: ...

    async def expect(
        self,
        hardware_id: str,
        stream_id: str,
        anchor_name: str,
        offset_ms: float,
        within_ms: float,
        match: Record,
    ) -> tuple[Record, Record]: ...

    def guard(self, hardware_id: str, stream_id: str, condition: Record) -> GuardWatch: ...


@dataclass(frozen=True)
class RunPorts:
    """Everything a run reaches outside itself."""

    devices: Any  # ``call_aggregated_tool(externalName, arguments, options)``
    resolver: Any  # ``resolve(hardwareId, toolName) -> (binding, issues)``
    execution: Any  # ``acquire(activity) -> handle`` (workstation-wide exclusivity)
    operations: OperationLog
    step_plugins: Mapping[str, Any]
    journal: Callable[[str], Journal]
    streams: Callable[[str, Callable[[str, Record], None]], RunStreams]
    published: Callable[[RunInterpreter, Record], None]
    finished: Callable[[RunInterpreter], None]
    clock: Callable[[], float]


class _AbortRun(Exception):
    pass


class _StopRegion(Exception):
    pass


class _PluginExecutionContext:
    """Narrow plugin surface that does not expose application or engine services."""

    __slots__ = ("__run",)

    def __init__(self, run: RunInterpreter) -> None:
        self.__run = run

    async def invoke_device(
        self, hardware_id: str, tool_name: str, arguments: Record, timeout_ms: int
    ) -> Any:
        return await self.__run.invoke_device(hardware_id, tool_name, arguments, timeout_ms)

    def publish_result(self, result: Record) -> None:
        self.__run.publish_result(result)

    async def checkpoint(self) -> None:
        await self.__run.checkpoint()


class RunInterpreter:
    def __init__(
        self,
        ports: RunPorts,
        plan: Record,
        parameters: Record,
        execution_revision: str | None = None,
        tags: Record | None = None,
    ) -> None:
        self.ports, self.plan, self.parameters = ports, clone(plan), clone(parameters)
        self._protocols: PlanProtocols | None = None
        self.tags = {key: value for key, value in (tags or {}).items() if value is not None}
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
        self.activity_handle: Any = None
        self.wait_tasks: set[asyncio.Task[Any]] = set()
        self.manual_checks: dict[str, tuple[Record, asyncio.Future[Record]]] = {}
        self.guard_violation = False
        self.guard_stopping = 0
        self.journal = ports.journal(self.run_id)
        self.io = ports.streams(self.run_id, self.emit)

    def _aborted_verdict(self) -> str:
        return "Fail" if self.guard_violation else "Aborted"

    def request_abort(self) -> None:
        self.abort_requested = True
        self.pause_gate.set()
        for task in [*self.hardware_tasks, *self.wait_tasks]:
            task.cancel()

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
            **clone(self.tags),
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
            "manualChecks": [clone(request) for request, _ in self.manual_checks.values()],
            **({"primaryError": clone(self.primary_error)} if self.primary_error else {}),
            "coverage": self._coverage_summary(),
            "operations": self.ports.operations.operations(self.run_id),
        }

    async def execute(self) -> None:
        try:
            self.journal.create(self.plan)
            hardware_ids = plan_hardware_ids(self.plan)
            self.activity_handle = self.ports.execution.acquire(
                {
                    "state": "run",
                    "runId": self.run_id,
                    "planId": self.plan["id"],
                    "revision": self.plan["revision"],
                    "hardwareIds": hardware_ids,
                    "startedAt": self.started_at,
                }
            )
            try:
                await self.io.start(hardware_ids, self.protocols)
            except Exception:
                self.activity_handle.release()
                self.activity_handle = None
                raise
            self.state = "running"
            self.execution_status = "Running"
            self.emit("run.started", {"parameters": self.parameters})
            self.ports.operations.save_run(self.snapshot())
            self.started.set()
            await self._region("prepare", self.plan["regions"]["prepare"])
            if self.abort_requested:
                raise _AbortRun()
            if self.verdict != "Error":
                await self._region("test", self.plan["regions"]["test"])
        except _AbortRun:
            # A Guard that aborts the run fails it; a user abort leaves it Aborted.
            self.verdict = aggregate_verdict(self.verdict, self._aborted_verdict())
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
                await self.io.stop()
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
                self.ports.operations.save_run(self.snapshot())
                self.journal.finish(self.snapshot(), self.events)
            self.ports.finished(self)

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
            verdict = self._aborted_verdict()
            outcome_known = not bool(self.hardware_tasks)
            raise
        except asyncio.CancelledError as error:
            verdict, outcome_known = self._aborted_verdict(), False
            raise _AbortRun() from error
        except Exception as error:
            if self.abort_requested or self.guard_stopping:
                verdict, outcome_known = self._aborted_verdict(), False
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
        if kind == "InvokeTool":
            arguments = self.bind(step.get("arguments", {}))
            binding = self.plan.get("resolvedBindings", {}).get(step["id"])
            if step.get("encode") is not None:
                arguments = self._encoded(step, arguments, binding)
            output, call = await self._invoke(
                step["hardwareId"],
                step["toolName"],
                arguments,
                int(step.get("timeoutMs", 30_000)),
                binding=binding,
                cleanup=cleanup,
            )
            if step.get("anchor"):
                anchor = self.io.set_anchor(str(step["anchor"]), step["hardwareId"], call["timing"])
                self.emit("anchor.set", {"anchor": anchor, **self._current_execution_reference()})
            verdict = "Pass"
            if step.get("assertions"):
                assertions = self.bind(step["assertions"])
                value = {"result": output, "timing": call["timing"], "arguments": arguments}
                spec = {
                    "type": "result",
                    "hardwareId": step["hardwareId"],
                    "value": value,
                    "assertions": assertions,
                }
                verdict = self._publish_verdict(step, judge.check_result(value, assertions), spec)
            return output, verdict
        if kind == "Observe":
            spec, judged = await self._interruptible(
                self.io.observe(
                    str(step["hardwareId"]),
                    str(step["streamId"]),
                    self.bind(step["window"]),
                    self.bind(step["assertions"]),
                    int(self.value(step, "minSamples", judge.MIN_SAMPLES)),
                )
            )
            return finite(judged), self._publish_verdict(step, judged, spec)
        if kind == "Expect":
            spec, judged = await self._interruptible(
                self.io.expect(
                    str(step["hardwareId"]),
                    str(step["streamId"]),
                    str(step["anchor"]),
                    float(self.value(step, "offsetMs", 0)),
                    float(self.value(step, "withinMs")),
                    self.bind(step["match"]),
                )
            )
            if isinstance(step.get("capture"), dict):  # §7.5 steps.<id>.captures.<name>
                judged = judge.apply_capture(judged, self.bind(step["capture"]))
            return finite(judged), self._publish_verdict(step, judged, spec)
        if kind == "Guard":
            return await self._guard(step, cleanup, execution_id)
        if kind == "ManualCheck":
            return await self._manual_check(step, execution_id)
        if kind == "PublishResult":
            published_result = {
                "kind": str(step.get("resultKind", "note")),
                "name": step.get("name", step["id"]),
                "value": self.value(step, "value"),
                "unit": step.get("unit"),
                "metadata": self.bind(step.get("metadata", {})),
                "sourceStepId": step["id"],
            }
            if step.get("evidenceType") in judge.EVIDENCE_TYPES:
                published_result["evidenceType"] = step["evidenceType"]
            self.publish_result(published_result)
            return published_result, str(step.get("verdict", "Pass"))
        plugin = self.ports.step_plugins.get(kind)
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

    async def _guard(self, step: Record, cleanup: bool, execution_id: str) -> tuple[Any, str]:
        """Run the children while the stream holds ``condition``; stop them on a violation."""
        session = self.io.guard(
            str(step["hardwareId"]), str(step["streamId"]), self.bind(step["condition"])
        )
        watching = session.begin()
        children = asyncio.ensure_future(
            self._steps(
                step.get("children", []),
                cleanup,
                bool(step.get("stopOnFail")),
                parent_execution_id=execution_id,
                branch="children",
            )
        )
        watch = asyncio.ensure_future(session.watch()) if watching else None
        violation: Record | None = None
        abort = step.get("onViolation", "abort") == "abort"
        try:
            if watch is not None:
                await asyncio.wait({children, watch}, return_when=asyncio.FIRST_COMPLETED)
                if watch.done() and not watch.cancelled():
                    if watch.exception() is None:
                        violation = watch.result()
                    else:
                        LOGGER.warning(
                            "Guard %s stopped watching", step["id"], exc_info=watch.exception()
                        )
            if violation is not None:
                self.emit(
                    "guard.violated",
                    {
                        "stepId": step["id"],
                        "violation": finite(violation),
                        "key": stream_key(step["hardwareId"], step["streamId"]),
                        "onViolation": "abort" if abort else "fail",
                    },
                )
                self.guard_stopping += 1
                children.cancel()
                try:
                    with contextlib.suppress(_AbortRun, asyncio.CancelledError):
                        await children
                finally:
                    self.guard_stopping -= 1
                children_verdict = "Fail"
            else:
                children_verdict = await children
        except BaseException:
            children.cancel()
            raise
        finally:
            if watch is not None:
                watch.cancel()
        spec, result = await self._interruptible(session.finish())
        if violation is not None and result.get("verdict") != judge.FAIL:
            result = {
                **result,
                "verdict": judge.FAIL,
                "violation": violation,
                "message": violation.get("message"),
            }
        verdict = aggregate_verdict(children_verdict, self._publish_verdict(step, result, spec))
        if violation is not None and abort:
            self.guard_violation = True
            self.request_abort()
            raise _AbortRun()
        return finite({"violation": violation, **result}), verdict

    async def _manual_check(self, step: Record, execution_id: str) -> tuple[Any, str]:
        """Wait for the operator's answer (§7.2); no answer in time is ``operator_undecided``."""
        timeout_ms = step.get("timeoutMs")
        request = {
            "executionId": execution_id,
            "stepId": step["id"],
            "name": step.get("name", step["id"]),
            "prompt": str(self.bind(step["prompt"])),
            "images": [str(image) for image in self.bind(step.get("images", []))],
            "options": manual_options(step),
            "requireNote": bool(step.get("requireNote")),
            "requestedAt": utc_now_iso(),
            **({"timeoutMs": int(timeout_ms)} if timeout_ms else {}),
        }
        answer: asyncio.Future[Record] = asyncio.get_running_loop().create_future()
        self.manual_checks[execution_id] = (request, answer)
        try:
            self.emit("manual.requested", {"request": clone(request)})
            timeout = int(timeout_ms) / 1000 if timeout_ms else None
            response = await self._interruptible(asyncio.wait_for(answer, timeout))
        except TimeoutError:
            response = {
                "option": None,
                "verdict": judge.INCONCLUSIVE,
                "note": "",
                "operator": None,
                "t": utc_now_iso(),
                "timedOut": True,
            }
        finally:
            self.manual_checks.pop(execution_id, None)
        self.emit(
            "manual.answered", {"executionId": execution_id, "stepId": step["id"], **response}
        )
        result = {
            **response,
            "evidenceType": "M",
            **(
                {"reason": "operator_undecided"}
                if response["verdict"] == judge.INCONCLUSIVE
                else {}
            ),
        }
        spec = {"type": "manual", "prompt": request["prompt"], "options": request["options"]}
        return result, self._publish_verdict(step, result, spec)

    def answer_manual_check(self, execution_id: str, option: str, note: str, operator: str) -> None:
        pending = self.manual_checks.get(execution_id)
        if pending is None or pending[1].done():
            raise app_error("conflict", "This manual check is no longer waiting for an answer")
        request, answer = pending
        chosen = next((item for item in request["options"] if item["label"] == option), None)
        if chosen is None:
            raise app_error("invalid_argument", f"Unknown option {option!r}")
        if request["requireNote"] and not note.strip():
            raise app_error("invalid_argument", "This manual check requires a note")
        answer.set_result(
            {
                "option": option,
                "verdict": chosen["verdict"],
                "note": note,
                "operator": operator,
                "t": utc_now_iso(),
            }
        )

    async def _interruptible(self, coroutine: Coroutine[Any, Any, T]) -> T:
        """Await a stream wait that ``abort`` can cancel."""
        task = asyncio.ensure_future(coroutine)
        self.wait_tasks.add(task)
        try:
            return await task
        finally:
            self.wait_tasks.discard(task)

    def _publish_verdict(self, step: Record, result: Record, spec: Record) -> str:
        verdict = step_verdict(result)
        self.publish_result(
            finite(
                {
                    "kind": "verdict",
                    "name": step.get("name", step["id"]),
                    "stepType": step["type"],
                    "verdict": verdict,
                    "judge": spec,
                    "evidence": {key: value for key, value in result.items() if key != "verdict"},
                    **(
                        {"evidenceType": result["evidenceType"]}
                        if result.get("evidenceType") in judge.EVIDENCE_TYPES
                        else {}
                    ),
                    "requirementIds": clone(step.get("requirementIds", [])),
                    "sourceStepId": step["id"],
                    "hardwareId": step.get("hardwareId"),
                    **({"streamId": step["streamId"]} if step.get("streamId") else {}),
                    **({"toolName": step["toolName"]} if step.get("toolName") else {}),
                }
            )
        )
        return verdict

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
        output, _ = await self._invoke(
            hardware_id, tool_name, arguments, timeout_ms, binding=binding, cleanup=cleanup
        )
        return output

    async def _invoke(
        self,
        hardware_id: str,
        tool_name: str,
        arguments: Record,
        timeout_ms: int,
        *,
        binding: Record | None = None,
        cleanup: bool = False,
    ) -> tuple[Any, Record]:
        """Call a hardware tool; returns its output and the call record (timing, streamRefs)."""
        tool, issues = (
            (binding, []) if binding else self.ports.resolver.resolve(hardware_id, tool_name)
        )
        if not tool:
            raise app_error(
                "validation_failed", "Hardware tool binding is invalid", {"issues": issues}
            )
        lock = self.io.device_lock(hardware_id)
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
                "arguments": clone(arguments),
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
            self.ports.operations.record_operation(operation)
            self.emit("operation.accepted", {"operation": operation})
            options = {"envelope": True, "operationId": operation_id}
            backend_start = self.ports.clock()
            task = asyncio.create_task(
                self.ports.devices.call_aggregated_tool(tool["externalName"], arguments, options)
            )
            self.ports.operations.update_operation(operation_id, state="dispatched")
            self.emit(
                "operation.dispatched",
                {
                    "operationId": operation_id,
                    **self._current_execution_reference(),
                },
            )
            self.hardware_tasks.add(task)
            try:
                envelope = await asyncio.wait_for(task, timeout=max(1, timeout_ms) / 1000)
                meta = envelope.get("meta") or {}
                call = {
                    "timing": self.io.timing(hardware_id, backend_start, self.ports.clock(), meta),
                    "streamRefs": list(meta.get("streamRefs") or []),
                }
                self.ports.operations.update_operation(operation_id, **call)
                output = envelope["data"]
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
                self.ports.operations.update_operation(
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
                        "timing": call["timing"],
                        **self._current_execution_reference(),
                    },
                )
                return output, call
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
                meta = getattr(error, "meta", None)
                if isinstance(meta, dict):
                    self.ports.operations.update_operation(
                        operation_id,
                        timing=self.io.timing(hardware_id, backend_start, self.ports.clock(), meta),
                        streamRefs=list(meta.get("streamRefs") or []),
                    )
                self.ports.operations.update_operation(
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
        self.ports.operations.update_operation(
            operation_id,
            state="outcome_unknown",
            outcomeKnown=False,
            recoveryRequired=True,
        )

    def _resolve_hardware_recovery(self, hardware_id: str, resolved_by: str) -> None:
        resolved_at = utc_now_iso()
        for operation in self.ports.operations.operations(self.run_id, recovery_only=True):
            if operation["hardwareId"] != hardware_id or operation["operationId"] == resolved_by:
                continue
            self.ports.operations.update_operation(
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
        operations = self.ports.operations.operations(self.run_id)
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

    @property
    def protocols(self) -> PlanProtocols:
        if self._protocols is None:
            self._protocols = PlanProtocols.from_plan(self.plan)
        return self._protocols

    def _encoded(self, step: Record, arguments: Record, binding: Record | None) -> Record:
        """``InvokeTool.encode``: build the frame from the frozen ICD into the tool argument."""
        spec = self.bind(step["encode"])
        target = encode_target(spec, (binding or {}).get("inputSchema"))
        if target is None:
            raise app_error(
                "invalid_argument",
                f"{step['toolName']} has no argument for the encoded frame; set encode.argument",
            )
        try:
            return self.protocols.encode_arguments(spec, arguments, target)
        except Exception as error:
            raise app_error(
                "invalid_argument", f"Encoding {spec.get('message')!r} failed: {error}"
            ) from error

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
        self.journal.append_result(result)
        self.emit("result.published", {"result": result})

    def _coverage_summary(self) -> Record:
        requirements = {
            str(item.get("id")): item
            for item in self.plan.get("requirements", [])
            if isinstance(item, dict) and item.get("id")
        }
        output = []
        for identifier, requirement in requirements.items():
            verdicts = [
                str(result.get("verdict"))
                for result in self.results
                if result.get("kind") == "verdict"
                and identifier in result.get("requirementIds", [])
            ]
            if not verdicts:
                status = "NotRun"
            elif "Fail" in verdicts:
                status = "Failed"
            elif all(verdict == "Pass" for verdict in verdicts):
                status = "Passed"
            else:
                status = "InsufficientEvidence"
            output.append(
                {
                    "requirementId": identifier,
                    "name": requirement.get("name", identifier),
                    "status": status,
                    "evidenceCount": len(verdicts),
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
            "tb": round(self.ports.clock(), 3),
            **clone(data),
        }
        self.events.append(event)
        with contextlib.suppress(Exception):
            self.ports.operations.save_run(self.snapshot())
        self.journal.append_event(event)
        self.ports.published(self, event)

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
