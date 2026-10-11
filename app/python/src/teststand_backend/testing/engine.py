"""The test engine: starts runs and answers queries about them (design doc §9.5).

Execution itself is :class:`~.interpreter.RunInterpreter`; this module wires it to the
devices, the stream recording (:mod:`.run_io`), the operation log (:mod:`.runtime_state`)
and the run journal (:mod:`.journal`), and reads finished runs back.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from teststand_backend.contracts.errors import app_error
from teststand_backend.streams import judge
from teststand_backend.streams.clock import backend_ms
from teststand_backend.streams.store import (
    SAMPLED_TYPES,
    StreamStore,
    check_keys,
    column_ms,
    points,
    read_query,
)
from teststand_backend.util import clone, utc_now_iso

from .derived_views import DerivedViews
from .interpreter import RunInterpreter, RunPorts
from .journal import RunJournal, recording_path
from .models import plan_hardware_ids
from .run_io import RunIO, rejudge
from .runtime_state import RuntimeStateStore
from .timeline import attach_call_results, build_timeline

Record = dict[str, Any]


IO_LIMIT = 50
IO_LIMIT_MAX = 500


def _sampled_summary(rows: list[Record], stream_type: str) -> Record:
    if stream_type == "bits":
        masks = [row.get("mask") for row in rows]
        changes = sum(1 for a, b in zip(masks, masks[1:], strict=False) if a != b)
        return {
            "count": len(rows),
            "first": masks[0] if masks else None,
            "last": masks[-1] if masks else None,
            "changes": changes,
        }
    values = [
        float(point["v"])
        for point in points(rows, stream_type)
        if isinstance(point.get("v"), (int, float)) and not isinstance(point["v"], bool)
    ]
    return judge.scalar_metrics(values)


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
        stream_sources: Any = None,
    ) -> None:
        self.projects, self.devices, self.resolver, self.execution = (
            projects,
            devices,
            resolver,
            execution,
        )
        self.stream_sources = stream_sources
        self.listeners = listeners or []
        self.runtime = runtime_state or RuntimeStateStore(projects)
        self.step_plugins = {plugin.type_name: plugin for plugin in (step_plugins or [])}
        self._runs: dict[str, RunInterpreter] = {}
        self.active: RunInterpreter | None = None
        self._recordings: dict[str, RunIO] = {}
        self._project: tuple[str, str] | None = None
        self.derived_views = DerivedViews()
        self.notifier: Any = None

    @property
    def runs(self) -> dict[str, RunInterpreter]:
        """The current project's runs in memory."""
        self._follow_project()
        return self._runs

    @property
    def recordings(self) -> dict[str, RunIO]:
        self._follow_project()
        return self._recordings

    def _follow_project(self) -> None:
        """Forget the previous project's runs once another project is open (a run still going
        keeps them until it ends)."""
        session = self.projects.session()
        project = (str(session["rootPath"]), str(session["projectId"])) if session else None
        if project == self._project or (self.active is not None and not self.active.done):
            return
        self._project = project
        self._runs, self._recordings = {}, {}
        self.active = None
        self.derived_views = DerivedViews()

    def set_notifier(self, notifier: Any) -> None:
        self.notifier = notifier

    async def start(
        self,
        plan: Record,
        parameters: Record,
        execution_revision: str | None = None,
        tags: Record | None = None,
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
        run = RunInterpreter(self._ports(), plan, parameters, execution_revision, tags)
        self.runs[run.run_id] = run
        self.active = run
        run.task = asyncio.create_task(run.execute())
        await run.started.wait()
        if run.start_error:
            self.active = None
            raise run.start_error
        return run.snapshot()

    def get(self, run_id: str | None = None) -> Record | None:
        runs = self.runs
        run = runs.get(run_id) if run_id else self.active
        if run:
            return run.snapshot()
        return self.runtime.load_run(run_id) if run_id else None

    def current(self) -> Record | None:
        self._follow_project()
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
        run.request_abort()
        run.emit("run.abortRequested", {})
        return run.snapshot()

    def answer_manual_check(
        self, run_id: str, execution_id: str, option: str, note: str, operator: str
    ) -> Record:
        run = self._require(run_id)
        run.answer_manual_check(execution_id, option, note, operator)
        return run.snapshot()

    def rejudge_run(self, run_id: str) -> Record:
        """Recompute every stream / result verdict of a finished run from its recording."""
        run = self.runs.get(run_id)
        if run and not run.done:
            raise app_error("conflict", "Cannot rejudge a run that is still active")
        results = self.read_results(run_id)["results"]
        items = rejudge(results, recording_path(self._run_path(run_id)))
        return {
            "runId": run_id,
            "results": items,
            "consistent": all(item["same"] for item in items),
        }

    @contextlib.contextmanager
    def _stream_store(self, run_id: str) -> Iterator[StreamStore | None]:
        """The run's recording: the live store while it records, else a read-only copy."""
        run = self.runs.get(run_id)
        recording = self.recordings.get(run_id) if run is not None else None
        live = recording.store if recording is not None else None
        if live is not None and not live.closed:
            yield live
            return
        if run is None and not self.runtime.load_run(run_id):
            raise app_error("not_found", f"Test run not found: {run_id}")
        path = recording_path(self._run_path(run_id))
        if path is None:
            yield None
            return
        store = StreamStore(path, readonly=True)
        try:
            yield store
        finally:
            store.close()

    def list_run_streams(self, run_id: str) -> Record:
        with self._stream_store(run_id) as store:
            if store is None:
                return {"runId": run_id, "recording": False, "streams": []}
            return {"runId": run_id, "recording": store.recording, "streams": store.streams()}

    def read_run_stream(self, run_id: str, key: str, query: Record) -> Record:
        """One recorded stream for display, paged by ``after`` (see :meth:`StreamStore.read`);
        a running run's new data arrives over ``GET /api/live``."""
        arguments = read_query(query)
        with self._stream_store(run_id) as store:
            if store is None:
                raise app_error("not_found", f"Run {run_id} has no stream recording")
            return store.read(key, **arguments)

    def stream_window(
        self, run_id: str, keys: list[str], t0: float, t1: float, width: int
    ) -> Record:
        """Recorded streams over ``[t0, t1]`` for a ``width``-column display (design doc
        5.9.3): see :meth:`StreamStore.window`."""
        keys = check_keys(keys)
        col = column_ms(t1 - t0, width)
        with self._stream_store(run_id) as store:
            if store is None:
                raise app_error("not_found", f"Run {run_id} has no stream recording")
            known = {entry["key"] for entry in store.streams()}
            protocols = self.derived_views.protocols(store)
            derived = {
                key: ref
                for key in keys
                if key not in known
                and (ref := protocols.derived_by_key(key)) is not None
                and ref.stream.stream_type == "scalar"
            }
            missing = [key for key in keys if key not in known and key not in derived]
            if missing:
                raise app_error(
                    "not_found",
                    f"Run {run_id} did not record {', '.join(missing)}",
                    {"keys": missing},
                )
            return {
                "runId": run_id,
                "t0": t0,
                "t1": t1,
                "colMs": col,
                "recording": store.recording,
                "streams": {
                    key: self.derived_views.window(run_id, store, key, derived[key], t0, t1, col)
                    if key in derived
                    else store.window(key, t0, t1, col_ms=col)
                    for key in keys
                },
            }

    def get_run_timeline(self, run_id: str) -> Record:
        run = self.runs.get(run_id)
        if run is not None:
            events = [clone(event) for event in run.events]
            results = [clone(result) for result in run.results]
        else:
            if not self.runtime.load_run(run_id):
                raise app_error("not_found", f"Test run not found: {run_id}")
            journal = self._journal(run_id)
            events, results = journal.events(), journal.results()
        with self._stream_store(run_id) as store:
            streams = store.streams() if store is not None else []
            gaps = {item["key"]: store.gaps(item["key"]) for item in streams} if store else {}
            # Derived numeric fields once the run is over: the live scope reads the hub,
            # which carries raw streams only.
            if store is not None and (run is None or run.done):
                recorded = {str(item["key"]): item for item in streams}
                for info in self.derived_views.stream_infos(run_id, store, recorded):
                    streams.append(info)
                    gaps[info["key"]] = gaps.get(info["derived"]["source"], [])
        timeline = build_timeline(run_id, events, results, streams, gaps)
        attach_call_results(timeline["calls"], self.runtime.operations(run_id))
        return timeline

    def read_run_messages(self, run_id: str, query: Record) -> Record:
        """The run's protocol traffic decoded with its frozen ICDs (U4 message table)."""
        with self._stream_store(run_id) as store:
            if store is None:
                return {
                    "runId": run_id,
                    "bindings": [],
                    "messages": [],
                    "total": 0,
                    "truncated": False,
                }
            return {"runId": run_id, **self.derived_views.messages(run_id, store, query)}

    def read_run_io(self, run_id: str, step_id: str | None = None, limit: int = IO_LIMIT) -> Record:
        """What a run (or every execution of one step) sent and saw, compact for an agent:
        its calls, verdict windows and violations, sampled streams as statistics and
        byte / frame / event streams as records."""
        timeline = self.get_run_timeline(run_id)
        steps = [
            step for step in timeline["steps"] if step_id is None or step.get("stepId") == step_id
        ]
        if step_id is not None and not steps:
            raise app_error(
                "not_found",
                f"Run {run_id} has no step {step_id}",
                {"runId": run_id, "stepId": step_id},
            )
        lo = hi = None
        if step_id is not None:
            starts = [step["tb0"] for step in steps if step.get("tb0") is not None]
            ends = [step["tb1"] for step in steps if step.get("tb1") is not None]
            lo = min(starts) if starts else None
            hi = max(ends) if ends and len(ends) == len(steps) else None

        def mine(item: Record) -> bool:
            return step_id is None or item.get("stepId") == step_id

        size = max(1, min(int(limit), IO_LIMIT_MAX))
        streams: list[Record] = []
        with self._stream_store(run_id) as store:
            for info in timeline["streams"]:
                key, stream_type = str(info["key"]), str(info.get("type") or "")
                entry: Record = {
                    "key": key,
                    "hardwareId": info.get("hardwareId"),
                    "streamId": info.get("streamId"),
                    "type": stream_type,
                    "gaps": info.get("gaps", 0),
                }
                derived = info.get("derived")
                if store is not None and derived:
                    entry["derived"] = derived
                    ref = self.derived_views.protocols(store).derived_by_key(key)
                    rows = [
                        row
                        for row in (self.derived_views.points(run_id, store, ref) if ref else [])
                        if (lo is None or row["tb"] >= lo) and (hi is None or row["tb"] <= hi)
                    ]
                    entry["summary"] = _sampled_summary(rows, "scalar")
                elif store is not None and stream_type in SAMPLED_TYPES:
                    rows = store.records(key, lo, hi, domain="tb")
                    entry["summary"] = _sampled_summary(rows, stream_type)
                elif store is not None:
                    data = store.read(key, t0=lo, t1=hi, limit=size)
                    entry["records"] = data["records"]
                    entry["more"] = data["next"] is not None
                streams.append(entry)
        return {
            "runId": run_id,
            "stepId": step_id,
            "tb0": lo,
            "tb1": hi,
            "steps": steps,
            "calls": [call for call in timeline["calls"] if mine(call)],
            "windows": [window for window in timeline["windows"] if mine(window)],
            "violations": [item for item in timeline["violations"] if mine(item)],
            "streams": streams,
        }

    def _run_path(self, run_id: str) -> Path:
        session = self.projects.session()
        if not session:
            raise app_error("requires_project", "requires_project")
        return Path(session["rootPath"]) / ".teststand" / "runs" / run_id

    async def wait(self, run_id: str, after_sequence: int = 0, timeout_ms: int = 30_000) -> Record:
        run = self.runs.get(run_id)
        if not run:
            snapshot = self.runtime.load_run(run_id)
            if not snapshot:
                raise app_error("not_found", f"Test run not found: {run_id}")
            return {
                "run": snapshot,
                "events": self._journal(run_id).events(after_sequence),
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
            results = self._journal(run_id).results(after_sequence)
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
            else self._journal(run_id).events(after_event_sequence)
        )
        all_results = (
            [clone(item) for item in run.results if item["sequence"] > after_result_sequence]
            if run
            else self._journal(run_id).results(after_result_sequence)
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
            "plan": self._journal(run_id).plan(),
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
        if self.projects.session():
            self._journal(run_id).reconciled(event, snapshot)
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

    def _journal(self, run_id: str) -> RunJournal:
        wiring = getattr(self.projects, "wiring", None)
        return RunJournal(self._run_path(run_id), wiring if callable(wiring) else None)

    def _streams(self, run_id: str, emit: Callable[[str, Record], None]) -> RunIO:
        monitor = getattr(self.projects, "monitor", None)
        watched = (
            [item["hardwareId"] for item in monitor()["channels"]] if callable(monitor) else []
        )
        io = RunIO(self.devices, self.stream_sources, self._run_path(run_id), run_id, emit, watched)
        self.recordings[run_id] = io
        return io

    def _ports(self) -> RunPorts:
        return RunPorts(
            devices=self.devices,
            resolver=self.resolver,
            execution=self.execution,
            operations=self.runtime,
            step_plugins=self.step_plugins,
            journal=self._journal,
            streams=self._streams,
            published=self._published,
            finished=self._finished,
            clock=backend_ms,
        )

    def _require(self, run_id: str) -> RunInterpreter:
        run = self.runs.get(run_id)
        if not run:
            raise app_error("not_found", f"Test run not found: {run_id}")
        return run

    def _finished(self, run: RunInterpreter) -> None:
        if self.active is run:
            self.active = None

    def _published(self, run: RunInterpreter, event: Record) -> None:
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
