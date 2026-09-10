from __future__ import annotations

import asyncio
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cmp_to_key
from typing import Any

from testforge_backend.compat import UNDEFINED, clone, new_uuid, utc_now_iso, utf16_compare
from testforge_backend.contracts.errors import app_error

from .cancellation import AbortController, AbortError, AbortSignal, abortable_delay, with_abort
from .machine import NodeMachine, RunMachine
from .persistence import RunPersistence
from .ports import (
    CatalogPort,
    ExecutionLease,
    ExecutionPort,
    Json,
    NoopExecution,
    NoopRunLogs,
    ProjectPort,
    RunLogPort,
    ToolPort,
)
from .store import RunStore
from .utils import bounded_value, normalize_error, positive_duration
from .workflow import (
    collect_task_steps,
    create_workflow_context,
    matches_workflow_type,
    read_json_pointer,
    resolve_workflow_value,
    runtime_type,
    validate_test_task,
    workflow_content_hash,
    workflow_expression_boolean,
)

ACTIVE = {"running", "cancelling"}


def _issue(code: str, message: str, node_id: str | None = None) -> Json:
    return {
        "severity": "error",
        "code": code,
        "message": message,
        **({"nodeId": node_id} if node_id else {}),
    }


class TaskValidator:
    def __init__(self, tools: ToolPort, catalog: CatalogPort) -> None:
        self.tools, self.catalog = tools, catalog

    def validate(self, task: Json) -> Json:
        issues = validate_test_task(task)["issues"]
        tools = {tool["externalName"]: tool for tool in self.tools.list_tools()}
        for step in collect_task_steps(task):
            if step["type"] != "tool" or not step["enabled"]:
                continue
            tool = tools.get(step["toolName"])
            if tool is None:
                issues.append(
                    _issue(
                        "unknown_tool",
                        f"MCP tool is unavailable: {step['toolName']}",
                        step["stepId"],
                    )
                )
            elif tool["kind"] != "hardware":
                issues.append(
                    _issue(
                        "tool_not_hardware",
                        f"Tool step requires a hardware-scoped MCP tool: {step['toolName']}",
                        step["stepId"],
                    )
                )
            try:
                hardware = self.catalog.get_hardware(step["hardwareId"])
                if hardware["kind"] != "managed":
                    issues.append(
                        _issue(
                            "passive_tool_target",
                            f"Tool step cannot target passive hardware {step['hardwareId']}",
                            step["stepId"],
                        )
                    )
                elif tool and hardware["serverId"] != tool["serverId"]:
                    issues.append(
                        _issue(
                            "tool_hardware_mismatch",
                            f"Tool {step['toolName']} belongs to {tool['serverId']}, "
                            f"not hardware server {hardware['serverId']}",
                            step["stepId"],
                        )
                    )
            except Exception:
                pass
        return {
            "valid": not any(issue["severity"] == "error" for issue in issues),
            "issues": issues,
        }

    def preflight(self, task: Json, canvas_hardware: list[str], inputs: Json) -> list[Json]:
        issues: list[Json] = self.validate(task)["issues"]
        variables = {item["name"]: item for item in task["inputs"]}
        for key in inputs:
            if key not in variables:
                issues.append(_issue("unknown_run_input", f"Unknown run input: {key}"))
        for definition in task["inputs"]:
            value = inputs.get(definition["name"], definition.get("defaultValue", UNDEFINED))
            if value is UNDEFINED:
                issues.append(
                    _issue("missing_run_input", f"Missing run input: {definition['name']}")
                )
            elif not matches_workflow_type(value, definition["type"]):
                issues.append(
                    _issue(
                        "run_input_type",
                        f"Run input {definition['name']} must be {definition['type']}",
                    )
                )
        for step in collect_task_steps(task):
            if step["type"] != "tool" or not step["enabled"]:
                continue
            hardware_id, sid = step["hardwareId"], step["stepId"]
            if hardware_id not in canvas_hardware:
                issues.append(
                    _issue(
                        "hardware_not_on_canvas",
                        f"Hardware {hardware_id} is not present on the project wiring canvas",
                        sid,
                    )
                )
            if not self.tools.is_hardware_occupied(hardware_id):
                issues.append(
                    _issue(
                        "hardware_not_occupied",
                        f"Hardware {hardware_id} must be occupied before this Run can start",
                        sid,
                    )
                )
            try:
                self.catalog.get_hardware(hardware_id)
            except Exception:
                issues.append(
                    _issue("unresolved_hardware", f"Hardware {hardware_id} is unresolved", sid)
                )
        return issues


@dataclass
class DecisionWaiter:
    future: asyncio.Future[str]
    options: Json


@dataclass
class ActiveRun:
    actor: RunMachine
    task: Json
    context: Json
    lease: ExecutionLease
    controller: AbortController = field(default_factory=AbortController)
    decisions: dict[str, DecisionWaiter] = field(default_factory=dict)
    hardware_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    resume: bool = False
    recovery_cleanup: bool = False
    completion: asyncio.Task[None] | None = None


class TaskOrchestrationService:
    __test__ = False

    def __init__(
        self,
        projects: ProjectPort,
        tools: ToolPort,
        catalog: CatalogPort,
        execution: ExecutionPort | None = None,
        run_logs: RunLogPort | None = None,
        safety: Json | None = None,
    ) -> None:
        self.projects, self.tools, self.catalog = projects, tools, catalog
        self.execution = execution or NoopExecution()
        self.safety = safety or {}
        self.notifier: Callable[[str, Any], None] | None = None
        self.store = RunStore(self._mutation)
        self.persistence = RunPersistence(
            run_logs or NoopRunLogs(), self.projects.session, self.store.add_warning
        )
        self.validator = TaskValidator(tools, catalog)
        self.active_runs: dict[str, ActiveRun] = {}
        self._start_lock = asyncio.Lock()
        self._closing = False
        self._close_task: asyncio.Task[None] | None = None

    def set_notifier(self, notifier: Callable[[str, Any], None]) -> None:
        self.notifier = notifier

    def _mutation(self, mutation: Json) -> None:
        if self.notifier and mutation["type"] in {"run", "nodeRun"}:
            self.notifier(mutation["type"], clone(mutation[mutation["type"]]))
        self.persistence.enqueue(mutation)

    async def initialize(self) -> None:
        session = self.projects.session()
        if session is None:
            return
        loaded = await self.persistence.logs.load(session["rootPath"])
        self.store.warnings = list(loaded["warnings"])
        for archive in loaded["archives"]:
            if archive["run"]["projectId"] != session["projectId"]:
                self.store.add_warning(
                    f"{archive['run']['runId']}: projectId does not match the open project"
                )
            else:
                self.store.load_archive(archive)
        snapshots = {snapshot["runId"]: snapshot for snapshot in loaded["snapshots"]}
        for run in list(self.store.runs.values()):
            if run["status"] in ACTIVE:
                self._recover(clone(run), snapshots.get(run["runId"]))
        await self.persistence.flush()

    def clear_session(self) -> None:
        self.store.clear()
        self.persistence.clear()

    def get_task(self) -> Json:
        return self.projects.task()

    def validate_task(self, task: Json) -> Json:
        return self.validator.validate(task)

    def update_task(self, task: Json) -> Json:
        validation = self.validate_task(task)
        if not validation["valid"]:
            raise app_error(
                "validation_failed", "Task is invalid", {"issues": validation["issues"]}
            )
        return self.projects.update_task(task)

    async def start_run(self, input: Json | None = None) -> Json:
        if self._closing:
            raise app_error("conflict", "Orchestration is closing")
        await asyncio.sleep(0)
        async with self._start_lock:
            if self._closing:
                raise app_error("conflict", "Orchestration is closing")
            if any(run["status"] in ACTIVE for run in self.store.runs.values()):
                raise app_error("conflict", "The project already has an active test run")
            task, wiring = self.projects.task(), self.projects.wiring()
            inputs = (input or {}).get("inputs", {})
            hardware_ids = _hardware_ids(task)
            issues = self.validator.preflight(
                task, [node["hardwareId"] for node in wiring["nodes"]], inputs
            )
            now = utc_now_iso()
            run: Json = {
                "runId": new_uuid(),
                "taskId": task["taskId"],
                "taskName": task["name"],
                "projectId": self.projects.project_id(),
                "status": "blocked" if issues else "running",
                "inputs": bounded_value(inputs),
                "createdAt": now,
            }
            run_id = run["runId"]
            if issues:
                run.update(
                    completedAt=now,
                    validationIssues=issues,
                    summary={
                        "passedNodes": 0,
                        "failedNodes": 0,
                        "cancelledNodes": 0,
                        "message": "Run blocked by preflight validation",
                    },
                )
                self.store.insert_run(run)
                self.store.add_event(run_id, "run.blocked", {"issues": issues})
                await asyncio.sleep(0)
                return self.store.get_run(run_id)
            run["startedAt"] = now
            lease = self.execution.acquire(
                {"state": "run", "runId": run_id, "hardwareIds": hardware_ids, "startedAt": now}
            )
            try:
                self.store.insert_run(run)
                self.store.add_event(run_id, "run.started", {"hardwareIds": hardware_ids})
                context = create_workflow_context(task, inputs)
                actor = RunMachine(run_id, "main", context)
                active = ActiveRun(actor, task, clone(context), lease)
                self.active_runs[run_id] = active
                self._checkpoint(active, "main")
                active.completion = asyncio.create_task(self._run_active(active))
                await asyncio.sleep(0)
                return self.store.get_run(run_id)
            except Exception:
                lease.release()
                raise

    async def cancel_run(self, run_id: str) -> Json:
        run = self.store.get_run_record(run_id)
        if run["status"] not in ACTIVE:
            return run
        active = self.active_runs.get(run_id)
        if run["status"] == "running":
            if active:
                active.actor.send("CANCEL")
                self._apply_state(active)
            else:
                self.store.update_run(
                    {**run, "status": "cancelling", "cancelRequestedAt": utc_now_iso()}
                )
                self.store.add_event(run_id, "run.cancel_requested")
        if active:
            self._abort(active, "Test run cancelled")
        return self.store.get_run_record(run_id)

    async def handle_hardware_lease_lost(self, hardware_id: str, message: str) -> None:
        affected = [
            active
            for active in self.active_runs.values()
            if hardware_id in _hardware_ids(active.task)
        ]
        for active in affected:
            active.actor.send("CANCEL")
            self._apply_state(active)
            self._abort(active, message)
        await asyncio.gather(
            *(active.completion for active in affected if active.completion), return_exceptions=True
        )

    def get_run(
        self, run_id: str, since_event_id: int = 0, node_offset: int = 0, node_limit: int = 200
    ) -> Json:
        return self.store.get_run(run_id, since_event_id, node_offset, node_limit)

    def list_runs(self, raw: Json | None = None) -> Json:
        return self.store.list_runs(raw)

    def export_run(self, run_id: str) -> Json:
        return self.store.archive(run_id)

    async def delete_run(self, run_id: str) -> Json:
        run = self.store.get_run_record(run_id)
        if run["status"] in ACTIVE:
            raise app_error("conflict", f"Run {run_id} is active and cannot be deleted")
        session = self._require_session()
        await self.persistence.remove(session["rootPath"], run_id)
        self.store.remove_run(run_id)
        return {"runId": run_id}

    async def clear_completed_runs(self) -> Json:
        run_ids = [key for key, run in self.store.runs.items() if run["status"] not in ACTIVE]
        session = self._require_session()
        await self.persistence.clear_runs(session["rootPath"], run_ids)
        for run_id in run_ids:
            self.store.remove_run(run_id)
        return {"deleted": len(run_ids)}

    def list_operator_decisions(self) -> list[Json]:
        return self.store.list_operator_decisions()

    async def respond_operator_decision(self, node_run_id: str, selected_value: str) -> Json:
        node = self.store.get_node(node_run_id)
        active = self.active_runs.get(node["runId"])
        waiter = active.decisions.get(node_run_id) if active else None
        if node["status"] != "waiting_operator" or waiter is None:
            raise app_error("conflict", "Operator decision is not active")
        if selected_value not in waiter.options:
            raise ValueError("Unknown operator option")
        node["decision"]["selectedValue"] = selected_value
        self.store.save_node(node)
        waiter.future.set_result(selected_value)
        assert active is not None
        active.decisions.pop(node_run_id, None)
        self.store.add_event(
            node["runId"],
            "operator.responded",
            {"nodeRunId": node_run_id, "selectedValue": selected_value},
        )
        return clone(node)

    async def close(self) -> None:
        if self._close_task:
            await self._close_task
            return
        self._closing = True
        self._close_task = asyncio.create_task(self._close())
        try:
            await self._close_task
        finally:
            self._close_task = None
            self._closing = False

    async def _close(self) -> None:
        async with self._start_lock:
            active_runs = list(self.active_runs.values())
            for active in active_runs:
                run = self.store.get_run_record(active.actor.context["runId"])
                if run["status"] in ACTIVE:
                    active.actor.send("INTERRUPT", message="Application shutdown")
                    self._apply_state(active, {"reason": "application_shutdown"})
                self._abort(active, "Application shutdown")
            await asyncio.gather(
                *(active.completion for active in active_runs if active.completion),
                return_exceptions=True,
            )
            for active in self.active_runs.values():
                active.lease.release()
            self.active_runs.clear()
            await self.persistence.flush()

    def _require_session(self) -> Json:
        session = self.projects.session()
        if session is None:
            raise app_error("requires_project", "No project is open")
        return session

    def _abort(self, active: ActiveRun, message: str) -> None:
        error = AbortError(message)
        active.controller.abort(error)
        for waiter in active.decisions.values():
            if not waiter.future.done():
                waiter.future.set_exception(error)
        active.decisions.clear()

    def _checkpoint(self, active: ActiveRun, phase: str) -> None:
        # root context retains its identity; only persisted copies are replaced.
        active.actor.checkpoint(phase, active.context)
        self.persistence.enqueue_snapshot(
            {
                "formatVersion": 1,
                "runId": active.actor.context["runId"],
                "task": clone(active.task),
                "workflowContext": clone(active.context),
                "phase": phase,
                "machine": active.actor.persisted_snapshot(),
                "updatedAt": utc_now_iso(),
            }
        )

    def _apply_state(self, active: ActiveRun, data: Any = UNDEFINED) -> None:
        actor = active.actor
        run_id, status = actor.context["runId"], actor.value
        current = self.store.get_run_record(run_id)
        if current["status"] == "interrupted" and status != "interrupted":
            return
        if status == "cancelling" and current["status"] != "cancelling":
            self.store.update_run({**current, "status": status, "cancelRequestedAt": utc_now_iso()})
            self.store.add_event(run_id, "run.cancel_requested")
        elif status in {"passed", "failed", "cancelled", "interrupted"} and (
            current["status"] != status or not current.get("completedAt")
        ):
            self.store.update_run(
                {
                    **current,
                    "status": status,
                    "completedAt": utc_now_iso(),
                    "summary": self.store.summary(run_id, actor.context.get("message")),
                }
            )
            self.store.add_event(run_id, f"run.{status}", data)
        self._checkpoint(active, actor.context["phase"])

    def _recover(self, run: Json, snapshot: Json | None) -> None:
        run_id = run["runId"]
        current_task = self.projects.task()
        task = (
            snapshot["task"]
            if snapshot
            else current_task
            if current_task["taskId"] == run["taskId"]
            else None
        )
        orphans = [
            node
            for node in self.store.list_nodes(run_id)
            if node["status"] in {"running", "waiting_operator"}
        ]
        for node in orphans:
            node.update(
                status="cancelled",
                completedAt=utc_now_iso(),
                error={
                    "category": "cancelled",
                    "message": "Application restarted while this node was active",
                },
            )
            self.store.save_node(node)
            self.store.add_event(
                run_id,
                "node.cancelled",
                {"nodeRunId": node["nodeRunId"], "reason": "application_restart"},
            )
        if task is None:
            self.store.update_run(
                {
                    **run,
                    "status": "interrupted",
                    "completedAt": utc_now_iso(),
                    "summary": self.store.summary(
                        run_id, "Application restarted and the task snapshot was unavailable"
                    ),
                }
            )
            self.store.add_event(run_id, "run.interrupted", {"reason": "missing_recovery_snapshot"})
            self.store.add_warning(
                f"{run_id}: active Run could not execute cleanup "
                "because its task snapshot is unavailable"
            )
            return
        steps = {step["stepId"]: step for step in collect_task_steps(task)}
        uncertain = any(
            steps.get(node["nodeId"], {}).get("type") == "tool"
            and not steps[node["nodeId"]]["idempotent"]
            for node in orphans
        )
        failed = any(node["status"] == "failed" for node in self.store.list_nodes(run_id))
        resume = (
            snapshot is not None
            and snapshot["phase"] == "main"
            and run["status"] == "running"
            and not uncertain
            and not failed
        )
        context = (
            snapshot["workflowContext"]
            if snapshot
            else create_workflow_context(task, run["inputs"])
        )
        machine = snapshot.get("machine") if snapshot else None
        persisted = (
            machine if isinstance(machine, dict) and machine.get("status") == "active" else None
        )
        actor = RunMachine(run_id, snapshot["phase"] if snapshot else "cleanup", context, persisted)
        if run["status"] == "cancelling" and actor.value == "running":
            actor.send("CANCEL")
        lease = self.execution.acquire(
            {
                "state": "run",
                "runId": run_id,
                "hardwareIds": _hardware_ids(task),
                "startedAt": run.get("startedAt", run["createdAt"]),
            }
        )
        active = ActiveRun(
            actor, task, clone(context), lease, resume=True, recovery_cleanup=not resume
        )
        self.active_runs[run_id] = active
        self.store.add_event(
            run_id,
            "run.recovery_resumed" if resume else "run.recovery_cleanup_started",
            {
                "orphanNodes": [node["nodeRunId"] for node in orphans],
                **({"reason": "uncertain_non_idempotent_tool"} if uncertain else {}),
            },
        )
        self._checkpoint(active, snapshot["phase"] if resume and snapshot else "cleanup")
        active.completion = asyncio.create_task(self._run_active(active))

    async def _run_active(self, active: ActiveRun) -> None:
        try:
            result = await self._execute(active)
            if active.actor.value == "interrupted" or result["status"] == "interrupted":
                return
            if active.recovery_cleanup:
                cleanup = result["cleanup"]
                message = (
                    "Application restarted; recovery cleanup completed"
                    if cleanup["status"] == "passed"
                    else "Application restarted; recovery cleanup failed: "
                    f"{cleanup.get('message', 'unknown error')}"
                )
                active.actor.send("INTERRUPT", message=message)
            else:
                active.actor.send(
                    {"passed": "PASS", "failed": "FAIL", "cancelled": "COMPLETE_CANCEL"}[
                        result["status"]
                    ],
                    message=result.get("message"),
                )
            self._apply_state(
                active,
                {
                    "main": result["main"],
                    "cleanup": result["cleanup"],
                    **(
                        {"recovery": True, "reason": "application_restart"}
                        if active.recovery_cleanup
                        else {}
                    ),
                },
            )
        except Exception as error:
            if active.actor.value != "interrupted":
                current = self.store.get_run_record(active.actor.context["runId"])
                active.actor.send(
                    "COMPLETE_CANCEL" if current["status"] == "cancelling" else "FAIL",
                    message=str(error),
                )
                self._apply_state(active, {"error": normalize_error(error)})
        finally:
            self.active_runs.pop(active.actor.context["runId"], None)
            active.hardware_locks.clear()
            active.lease.release()

    async def _execute(self, active: ActiveRun) -> Json:
        run_id = active.actor.context["runId"]
        main: Json = {"status": "passed"}
        try:
            if not active.recovery_cleanup:
                main = await self._sequence(
                    active,
                    [*active.task["setup"], *active.task["steps"]],
                    active.context,
                    active.controller.signal,
                    "root",
                    [],
                    False,
                )
        except Exception as error:
            main = {
                "status": "cancelled" if isinstance(error, AbortError) else "failed",
                "message": str(error),
            }
            self.store.add_event(run_id, "run.execution_error", {"error": normalize_error(error)})
        cleanup_controller = AbortController()
        self._checkpoint(active, "cleanup")
        budget = positive_duration(self.safety.get("cleanupBudgetMs"), 30000)
        timer = asyncio.get_running_loop().call_later(
            budget / 1000,
            cleanup_controller.abort,
            AbortError(f"Cleanup exceeded its {budget} ms safety budget"),
        )
        try:
            cleanup = await self._sequence(
                active,
                active.task["cleanup"],
                active.context,
                cleanup_controller.signal,
                "cleanup",
                [],
                True,
            )
        except Exception as error:
            cleanup = {"status": "failed", "message": str(error)}
            self.store.add_event(run_id, "run.cleanup_error", {"error": normalize_error(error)})
        finally:
            timer.cancel()
        current = self.store.get_run_record(run_id)
        if current["status"] == "interrupted":
            return {"status": "interrupted", "main": main, "cleanup": cleanup}
        cancelled = (
            current["status"] == "cancelling"
            or active.controller.signal.aborted
            or main["status"] == "cancelled"
        )
        status = (
            "cancelled"
            if cancelled
            else "passed"
            if main["status"] == cleanup["status"] == "passed"
            else "failed"
        )
        message = (
            f"Cleanup failed: {cleanup.get('message', 'unknown error')}"
            if cleanup["status"] == "failed"
            else main.get("message")
        )
        return {
            "status": status,
            "main": main,
            "cleanup": cleanup,
            **({"message": message} if message else {}),
        }

    async def _sequence(
        self,
        active: ActiveRun,
        steps: list[Json],
        context: Json,
        signal: AbortSignal,
        branch: str,
        iteration: list[int],
        cleanup: bool,
    ) -> Json:
        for step in steps:
            if not step["enabled"]:
                self._skip(active, step, branch, iteration)
                continue
            if signal.aborted:
                return _aborted(cleanup, signal.reason)
            if active.resume and self.store.find_node(
                active.actor.context["runId"], step["stepId"], branch, iteration, "passed"
            ):
                continue
            outcome = await self._node(active, step, context, signal, branch, iteration, cleanup)
            if outcome["status"] != "passed":
                return outcome
        return {"status": "passed"}

    async def _node(
        self,
        active: ActiveRun,
        step: Json,
        context: Json,
        signal: AbortSignal,
        branch: str,
        iteration: list[int],
        cleanup: bool,
    ) -> Json:
        run_id = active.actor.context["runId"]
        actor = NodeMachine()
        node: Json = {
            "nodeRunId": new_uuid(),
            "runId": run_id,
            "nodeId": step["stepId"],
            "nodeLabel": step["label"],
            "nodeType": step["type"],
            "status": actor.value,
            "branchPath": branch,
            "iterationPath": clone(iteration),
            "attempt": 1,
            "startedAt": utc_now_iso(),
        }
        self.store.insert_node(node)
        actor.send("START")
        node["status"] = actor.value
        self.store.save_node(node)
        self.store.add_event(
            run_id, "node.started", {"nodeRunId": node["nodeRunId"], "stepId": step["stepId"]}
        )
        try:
            outcome = await self._step(
                active, step, node, actor, context, signal, branch, iteration, cleanup
            )
            actor.send(
                {"passed": "PASS", "failed": "FAIL", "cancelled": "CANCEL"}[outcome["status"]]
            )
            node.update(status=actor.value, completedAt=utc_now_iso())
            if outcome.get("message") and outcome["status"] != "passed":
                node["error"] = {"category": outcome["status"], "message": outcome["message"]}
            self.store.save_node(node)
            self.store.add_event(
                run_id,
                f"node.{node['status']}",
                {"nodeRunId": node["nodeRunId"], "stepId": step["stepId"]},
            )
            self._checkpoint(
                active,
                "cleanup" if branch == "cleanup" or branch.startswith("cleanup.") else "main",
            )
            return outcome
        except Exception as error:
            actor.send("CANCEL" if getattr(error, "name", None) == "AbortError" else "FAIL")
            node.update(status=actor.value, completedAt=utc_now_iso(), error=normalize_error(error))
            self.store.save_node(node)
            self.store.add_event(
                run_id,
                f"node.{node['status']}",
                {"nodeRunId": node["nodeRunId"], "error": node["error"]},
            )
            self._checkpoint(
                active,
                "cleanup" if branch == "cleanup" or branch.startswith("cleanup.") else "main",
            )
            return {
                "status": "cancelled" if node["status"] == "cancelled" else "failed",
                "message": node["error"]["message"],
            }

    async def _step(
        self,
        active: ActiveRun,
        step: Json,
        node: Json,
        actor: NodeMachine,
        context: Json,
        signal: AbortSignal,
        branch: str,
        iteration: list[int],
        cleanup: bool,
    ) -> Json:
        kind = step["type"]
        if kind == "delay":
            duration = resolve_workflow_value(step["durationMs"], context)
            if (
                type(duration) not in (int, float)
                or not math.isfinite(duration)
                or duration < 0
                or duration > 1800000
            ):
                raise ValueError("Delay must resolve to a finite duration")
            await abortable_delay(duration, signal)
        elif kind == "set_variable":
            self._write(
                active, context, step["variable"], resolve_workflow_value(step["value"], context)
            )
        elif kind == "assert":
            if not workflow_expression_boolean(step["expression"], context):
                raise app_error("assertion_failed", step["message"] or "Assertion failed")
        elif kind == "if":
            return await self._sequence(
                active,
                step["then"]
                if workflow_expression_boolean(step["condition"], context)
                else step["else"],
                context,
                signal,
                f"{branch}.{step['stepId']}",
                iteration,
                cleanup,
            )
        elif kind == "loop":
            count: Any = (
                resolve_workflow_value(step["count"], context) if step["mode"] == "count" else None
            )
            maximum = step["maxIterations"]
            if step["mode"] == "count" and (
                type(count) not in (int, float)
                or not math.isfinite(count)
                or not float(count).is_integer()
                or count < 0
                or count > maximum
            ):
                raise ValueError(f"Loop count must be between 0 and {maximum}")
            index = 0
            while index < maximum:
                if signal.aborted:
                    return _aborted(cleanup, signal.reason)
                if (
                    (index >= count)
                    if count is not None
                    else not workflow_expression_boolean(step["condition"], context)
                ):
                    break
                self._write(active, context, step["indexVariable"], index)
                outcome = await self._sequence(
                    active,
                    step["body"],
                    context,
                    signal,
                    f"{branch}.{step['stepId']}",
                    [*iteration, index],
                    cleanup,
                )
                if outcome["status"] != "passed":
                    return outcome
                index += 1
            if (
                step["mode"] == "while"
                and index >= maximum
                and workflow_expression_boolean(step["condition"], context)
            ):
                raise app_error("loop_limit", f"Loop exceeded maxIterations {maximum}")
        elif kind == "parallel":
            snapshot = clone(context)
            controllers = [AbortController(signal) for _ in step["branches"]]

            async def execute_branch(item: Json, controller: AbortController) -> Json:
                result = await self._sequence(
                    active,
                    item["steps"],
                    clone(snapshot),
                    controller.signal,
                    f"{branch}.{item['branchId']}",
                    iteration,
                    cleanup,
                )
                if result["status"] != "passed":
                    for sibling in controllers:
                        if sibling is not controller:
                            sibling.abort(
                                AbortError(f"Parallel sibling {item['branchId']} did not pass")
                            )
                return result

            outcomes = await asyncio.gather(
                *(
                    execute_branch(item, controller)
                    for item, controller in zip(step["branches"], controllers, strict=True)
                )
            )
            return next(
                (outcome for outcome in outcomes if outcome["status"] != "passed"),
                {"status": "passed"},
            )
        elif kind == "operator":
            await self._operator(active, step, node, actor, context, signal, cleanup)
        elif kind == "tool":
            return await self._tool(active, step, node, context, signal, cleanup)
        return {"status": "passed"}

    async def _operator(
        self,
        active: ActiveRun,
        step: Json,
        node: Json,
        actor: NodeMachine,
        context: Json,
        signal: AbortSignal,
        cleanup: bool,
    ) -> None:
        options = {
            workflow_content_hash(option.get("value", UNDEFINED)): option.get("value", UNDEFINED)
            for option in step["options"]
        }
        actor.send("WAIT_OPERATOR")
        node.update(
            status=actor.value,
            decision={
                "prompt": step["prompt"],
                "options": [
                    {
                        "label": option["label"],
                        "value": workflow_content_hash(option.get("value", UNDEFINED)),
                    }
                    for option in step["options"]
                ],
            },
        )
        self.store.save_node(node)
        self._checkpoint(active, "cleanup" if cleanup else "main")
        self.store.add_event(
            node["runId"],
            "operator.waiting",
            {"nodeRunId": node["nodeRunId"], "stepId": step["stepId"]},
        )
        if self.notifier:
            self.notifier("operator", {"nodeRunId": node["nodeRunId"], "runId": node["runId"]})
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        active.decisions[node["nodeRunId"]] = DecisionWaiter(future, options)

        def abort() -> None:
            if not future.done():
                future.set_exception(
                    signal.reason or AbortError("Cleanup cancelled" if cleanup else "Run cancelled")
                )

        signal.add_callback(abort)
        timer: asyncio.TimerHandle | None = None
        if cleanup:
            timeout = positive_duration(self.safety.get("cleanupOperatorTimeoutMs"), 5000)

            def expire() -> None:
                if not future.done():
                    future.set_exception(
                        app_error(
                            "unavailable", f"Cleanup operator decision timed out after {timeout} ms"
                        )
                    )

            timer = asyncio.get_running_loop().call_later(timeout / 1000, expire)
        if signal.aborted:
            abort()
        try:
            selected = await future
        finally:
            if timer:
                timer.cancel()
            signal.remove_callback(abort)
            active.decisions.pop(node["nodeRunId"], None)
        if step.get("resultVariable"):
            self._write(active, context, step["resultVariable"], options[selected])

    async def _tool(
        self,
        active: ActiveRun,
        step: Json,
        node: Json,
        context: Json,
        signal: AbortSignal,
        cleanup: bool,
    ) -> Json:
        args = {
            key: resolve_workflow_value(value, context) for key, value in step["arguments"].items()
        }
        node["input"] = bounded_value(args)
        self.store.save_node(node)
        configured = step["retry"]["maxAttempts"]
        maximum = (
            int(configured)
            if step["idempotent"]
            and type(configured) in (int, float)
            and math.isfinite(configured)
            and float(configured).is_integer()
            and configured > 0
            else 1
        )
        key = workflow_content_hash(
            {
                "runId": node["runId"],
                "stepId": step["stepId"],
                "branchPath": node["branchPath"],
                "iterationPath": node["iterationPath"],
                "hardwareId": step["hardwareId"],
                "toolName": step["toolName"],
            }
        )
        lock = active.hardware_locks.setdefault(step["hardwareId"], asyncio.Lock())
        async with lock:
            signal.throw_if_aborted()
            last_error: Exception = app_error(
                "error", "Tool execution failed before an attempt completed"
            )
            for attempt in range(1, maximum + 1):
                if signal.aborted:
                    return _aborted(cleanup, signal.reason)
                node["attempt"] = attempt
                self.store.save_node(node)
                try:
                    output = await with_abort(
                        self.tools.call_tool(
                            step["toolName"],
                            args,
                            {
                                "timeoutMs": step["timeoutMs"],
                                "signal": signal,
                                "metadata": {
                                    "hardwareId": step["hardwareId"],
                                    "attempt": attempt,
                                    "idempotencyKey": key,
                                },
                            },
                        ),
                        signal,
                    )
                    for binding in step["outputBindings"]:
                        self._write(
                            active,
                            context,
                            binding["variable"],
                            read_json_pointer(output, binding["pointer"]),
                        )
                    node["output"] = bounded_value(output)
                    return {"status": "passed"}
                except Exception as error:
                    last_error = error
                    if signal.aborted or getattr(error, "name", None) == "AbortError":
                        return _aborted(cleanup, error)
                    normalized = normalize_error(error)
                    node.setdefault("attemptErrors", []).append(
                        {
                            "attempt": attempt,
                            "category": normalized["category"],
                            "message": normalized["message"],
                            "timestamp": utc_now_iso(),
                        }
                    )
                    self.store.save_node(node)
                    retryable = (
                        step["idempotent"] and normalized["category"] in step["retry"]["retryOn"]
                    )
                    if attempt < maximum and retryable:
                        delay = min(
                            300000,
                            step["retry"]["delayMs"]
                            * (
                                2 ** (attempt - 1)
                                if step["retry"]["backoff"] == "exponential"
                                else 1
                            ),
                        )
                        await abortable_delay(delay, signal)
                    else:
                        break
            raise last_error

    def _write(self, active: ActiveRun, context: Json, name: str, value: Any) -> None:
        expected = next(
            (variable["type"] for variable in active.task["variables"] if variable["name"] == name),
            None,
        )
        if expected is None:
            raise ValueError(f"Writable variable is not declared: {name}")
        if not matches_workflow_type(value, expected):
            raise ValueError(f"Variable {name} requires {expected}, received {runtime_type(value)}")
        context[name] = clone(value)

    def _skip(self, active: ActiveRun, step: Json, branch: str, iteration: list[int]) -> None:
        run_id = active.actor.context["runId"]
        if active.resume and self.store.find_node(
            run_id, step["stepId"], branch, iteration, "skipped"
        ):
            return
        node: Json = {
            "nodeRunId": new_uuid(),
            "runId": run_id,
            "nodeId": step["stepId"],
            "nodeLabel": step["label"],
            "nodeType": step["type"],
            "status": "skipped",
            "branchPath": branch,
            "iterationPath": clone(iteration),
            "attempt": 1,
            "startedAt": utc_now_iso(),
            "completedAt": utc_now_iso(),
        }
        self.store.insert_node(node)
        self.store.add_event(
            run_id, "node.skipped", {"nodeRunId": node["nodeRunId"], "stepId": step["stepId"]}
        )
        self._checkpoint(
            active, "cleanup" if branch == "cleanup" or branch.startswith("cleanup.") else "main"
        )


def _hardware_ids(task: Json) -> list[str]:
    return sorted(
        {
            step["hardwareId"]
            for step in collect_task_steps(task)
            if step["type"] == "tool" and step["enabled"]
        },
        key=cmp_to_key(utf16_compare),
    )


def _aborted(cleanup: bool, reason: Exception | None) -> Json:
    message = (
        str(reason)
        if reason
        else "Cleanup safety budget exceeded"
        if cleanup
        else "Run cancellation requested"
    )
    return {"status": "failed" if cleanup else "cancelled", "message": message}
