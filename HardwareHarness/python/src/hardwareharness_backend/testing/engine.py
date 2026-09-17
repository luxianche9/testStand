from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from ruamel.yaml import YAML

from hardwareharness_backend.compat import clone, new_uuid, utc_now_iso
from hardwareharness_backend.contracts.errors import app_error, to_wire_error

from .expression import evaluate
from .models import aggregate_verdict, plan_hardware_ids

Record = dict[str, Any]


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
    ) -> None:
        self.projects, self.devices, self.resolver, self.execution = (
            projects,
            devices,
            resolver,
            execution,
        )
        self.listeners = listeners or []
        self.step_plugins = {plugin.type_name: plugin for plugin in (step_plugins or [])}
        self.runs: dict[str, _Run] = {}
        self.active: _Run | None = None
        self.notifier: Any = None

    def set_notifier(self, notifier: Any) -> None:
        self.notifier = notifier

    async def start(self, plan: Record, parameters: Record) -> Record:
        if self.active and not self.active.done:
            raise app_error(
                "conflict", "A test plan is already running", {"runId": self.active.run_id}
            )
        run = _Run(self, plan, parameters)
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
        return run.snapshot() if run else None

    def current(self) -> Record | None:
        if self.active:
            return self.active.snapshot()
        latest = next(reversed(self.runs.values()), None) if self.runs else None
        return latest.snapshot() if latest else None

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
        run = self._require(run_id)
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
        run = self._require(run_id)
        return {
            "runId": run_id,
            "results": [clone(item) for item in run.results if item["sequence"] > after_sequence],
            "nextSequence": run.result_sequence,
        }

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
            self.notifier({"run": run.snapshot(), "event": clone(event)})


class _Run:
    def __init__(self, engine: TestEngine, plan: Record, parameters: Record) -> None:
        self.engine, self.plan, self.parameters = engine, clone(plan), clone(parameters)
        self.run_id = new_uuid()
        self.state = "starting"
        self.verdict = "NotSet"
        self.started_at = utc_now_iso()
        self.completed_at: str | None = None
        self.sequence = 0
        self.result_sequence = 0
        self.events: list[Record] = []
        self.results: list[Record] = []
        self.variables: Record = {}
        self.outputs: Record = {}
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
        return {
            "runId": self.run_id,
            "planId": self.plan["id"],
            "revision": self.plan["revision"],
            "planName": self.plan.get("name", ""),
            "state": self.state,
            "verdict": self.verdict,
            "startedAt": self.started_at,
            **({"completedAt": self.completed_at} if self.completed_at else {}),
            "sequence": self.sequence,
            "resultSequence": self.result_sequence,
            "currentStepId": self.variables.get("__currentStepId"),
            "pauseRequested": self.pause_requested,
            "abortRequested": self.abort_requested,
            "hardwareIds": plan_hardware_ids(self.plan),
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
            self.emit("run.started", {"parameters": self.parameters})
            self.started.set()
            await self._region("prepare", self.plan["regions"]["prepare"])
            if self.verdict != "Error" and not self.abort_requested:
                await self._region("test", self.plan["regions"]["test"])
        except _AbortRun:
            self.verdict = aggregate_verdict(self.verdict, "Aborted")
        except Exception as error:
            if not self.started.is_set():
                self.start_error = error
                self.started.set()
            self.verdict = aggregate_verdict(self.verdict, "Error")
            self.emit("run.error", {"error": to_wire_error(error)})
        finally:
            if self.started.is_set() and self.start_error is None:
                self.state = "cleaning"
                self.emit("run.cleanupStarted", {})
                try:
                    await self._region(
                        "cleanup", list(reversed(self.plan["regions"]["cleanup"])), cleanup=True
                    )
                except Exception as error:
                    self.verdict = aggregate_verdict(self.verdict, "Error")
                    self.emit("run.cleanupError", {"error": to_wire_error(error)})
                if self.activity_handle:
                    self.activity_handle.release()
                    self.activity_handle = None
                if self.verdict == "NotSet":
                    self.verdict = "Pass"
                self.state = (
                    "aborted"
                    if self.verdict == "Aborted"
                    else "error"
                    if self.verdict == "Error"
                    else "completed"
                )
                self.completed_at = utc_now_iso()
                self.emit("run.completed", {"verdict": self.verdict})
                self._write_json(self.run_dir / "summary.json", self.snapshot())
                (self.run_dir / "run.log").write_text(self._format_log(), encoding="utf-8")
            if self.engine.active is self:
                self.engine.active = None

    async def _region(self, name: str, steps: list[Record], cleanup: bool = False) -> None:
        self.emit("region.started", {"region": name})
        with contextlib.suppress(_StopRegion):
            await self._steps(
                steps, cleanup=cleanup, stop_on_fail=bool(self.plan.get("stopOnFail"))
            )
        self.emit("region.completed", {"region": name})

    async def _steps(
        self, steps: list[Record], cleanup: bool = False, stop_on_fail: bool = False
    ) -> str:
        verdict = "NotSet"
        for step in steps:
            if not step.get("enabled", True):
                self.emit("step.skipped", {"stepId": step.get("id"), "reason": "disabled"})
                continue
            result = await self._step(step, cleanup)
            verdict = aggregate_verdict(verdict, result)
            self.verdict = aggregate_verdict(self.verdict, result)
            if result == "Error" and not cleanup:
                raise _StopRegion()
            if result == "Fail" and (stop_on_fail or step.get("stopOnFail")):
                raise _StopRegion()
        return verdict

    async def _step(self, step: Record, cleanup: bool) -> str:
        if not cleanup:
            await self.checkpoint()
        step_id, step_type = step["id"], step["type"]
        self.variables["__currentStepId"] = step_id
        started = time.monotonic()
        self.emit("step.started", {"stepId": step_id, "stepType": step_type})
        verdict = "Pass"
        output: Any = None
        outcome_known = True
        try:
            output, verdict = await self._execute_step(step, cleanup)
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
            if step.get("errorPolicy") == "fail" and outcome_known:
                verdict = "Fail"
                output["handledAs"] = "Fail"
        finally:
            duration_ms = int((time.monotonic() - started) * 1000)
            if output is not None:
                self.outputs[step_id] = clone(output)
            event = {
                "stepId": step_id,
                "stepType": step_type,
                "verdict": verdict,
                "durationMs": duration_ms,
                "outcomeKnown": outcome_known,
                "output": output,
            }
            self.emit("step.completed", event)
        return verdict

    async def _execute_step(self, step: Record, cleanup: bool) -> tuple[Any, str]:
        kind = step["type"]
        if kind in {"Sequence", "Group"}:
            return None, await self._steps(
                step.get("children", []), cleanup, bool(step.get("stopOnFail"))
            )
        if kind == "If":
            branch = (
                step.get("children", [])
                if bool(self.expr(step.get("condition", "false")))
                else step.get("elseChildren", [])
            )
            return None, await self._steps(branch, cleanup, bool(step.get("stopOnFail")))
        if kind == "Repeat":
            repeat_verdict = "NotSet"
            count = max(
                0, min(int(self.value(step, "count", 1)), int(step.get("maxIterations", 10_000)))
            )
            for self.index in range(count):
                repeat_verdict = aggregate_verdict(
                    repeat_verdict,
                    await self._steps(
                        step.get("children", []), cleanup, bool(step.get("stopOnFail"))
                    ),
                )
            return {"iterations": count}, repeat_verdict
        if kind == "ForEach":
            items = list(self.value(step, "items", []))
            foreach_verdict = "NotSet"
            previous_item, previous_index = self.item, self.index
            for self.index, self.item in enumerate(items[: int(step.get("maxIterations", 10_000))]):
                foreach_verdict = aggregate_verdict(
                    foreach_verdict,
                    await self._steps(
                        step.get("children", []), cleanup, bool(step.get("stopOnFail"))
                    ),
                )
            self.item, self.index = previous_item, previous_index
            return {"iterations": len(items)}, foreach_verdict
        if kind == "Parallel":
            results = await asyncio.gather(
                *(self._step(child, cleanup) for child in step.get("children", []))
            )
            verdict = "NotSet"
            for result in results:
                verdict = aggregate_verdict(verdict, result)
            return None, verdict
        if kind == "Retry":
            attempts = max(1, min(int(step.get("attempts", 1)), 20))
            last = "Error"
            for attempt in range(attempts):
                try:
                    last = await self._steps(
                        step.get("children", []), cleanup, bool(step.get("stopOnFail"))
                    )
                    if last not in {"Error", "Fail"}:
                        return {"attempts": attempt + 1}, last
                except _StopRegion:
                    last = "Error"
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
            output = await self.invoke_device(
                step["hardwareId"], step["toolName"], arguments, int(step.get("timeoutMs", 30_000))
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
                "name": step.get("name", step["id"]),
                "actual": actual,
                "passed": passed,
                "limits": {
                    key: self.value(step, key)
                    for key in ("expected", "minimum", "maximum", "tolerance", "mask")
                    if key in step or key + "Expression" in step
                },
            }
            self.publish_result(assertion_result)
            return assertion_result, "Pass" if passed else "Fail"
        if kind == "PublishResult":
            published_result = {
                "name": step.get("name", step["id"]),
                "value": self.value(step, "value"),
                "unit": step.get("unit"),
                "metadata": self.bind(step.get("metadata", {})),
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
        self, hardware_id: str, tool_name: str, arguments: Record, timeout_ms: int
    ) -> Any:
        tool, issues = self.engine.resolver.resolve(hardware_id, tool_name)
        if not tool:
            raise app_error(
                "validation_failed", "Hardware tool binding is invalid", {"issues": issues}
            )
        lock = self.hardware_locks.setdefault(hardware_id, asyncio.Lock())
        async with lock:
            await self.checkpoint()
            task = asyncio.create_task(
                self.engine.devices.call_aggregated_tool(tool["externalName"], arguments)
            )
            self.hardware_tasks.add(task)
            try:
                output = await asyncio.wait_for(task, timeout=max(1, timeout_ms) / 1000)
                output_schema = tool.get("upstreamOutputSchema", tool.get("outputSchema", {}))
                if output_schema:
                    errors = list(Draft202012Validator(output_schema).iter_errors(output))
                    if errors:
                        raise app_error(
                            "invalid_response",
                            f"Hardware tool output failed schema validation: {errors[0].message}",
                            {"outcomeKnown": True, "toolName": tool_name},
                        )
                return output
            except TimeoutError as error:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise app_error(
                    "unavailable",
                    "Hardware call timed out; physical outcome is unknown",
                    {
                        "outcomeKnown": False,
                        "automaticRetry": False,
                        "hardwareId": hardware_id,
                        "toolName": tool_name,
                    },
                ) from error
            except asyncio.CancelledError as error:
                raise app_error(
                    "cancelled",
                    "Hardware call cancelled; physical outcome is unknown",
                    {
                        "outcomeKnown": False,
                        "automaticRetry": False,
                        "hardwareId": hardware_id,
                        "toolName": tool_name,
                    },
                ) from error
            finally:
                self.hardware_tasks.discard(task)

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
        result = {"sequence": self.result_sequence, "at": utc_now_iso(), **clone(value)}
        self.results.append(result)
        self._append_jsonl(self.run_dir / "results.jsonl", result)
        self.emit("result.published", {"result": result})

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
        if self.run_dir.exists():
            self._append_jsonl(self.run_dir / "events.jsonl", event)
        self.engine._published(self, event)

        async def wake() -> None:
            async with self.changed:
                self.changed.notify_all()

        asyncio.create_task(wake())

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
