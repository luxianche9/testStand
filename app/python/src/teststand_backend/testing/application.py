from __future__ import annotations

import asyncio
import contextlib
import getpass
from datetime import datetime
from typing import Any, cast

from teststand_backend.contracts.errors import AppError, app_error
from teststand_backend.contracts.operations import operation
from teststand_backend.protocol import load_icd
from teststand_backend.util import clone, new_uuid, utc_now_iso

from .batch import BatchCoordinator
from .catalog import step_catalog
from .models import plan_hardware_ids
from .protocols import describe_icd, trial_decode

Record = dict[str, Any]
_UNIT_KEY = "currentUnit"
_ORDER_KEY = "testItemOrder"


class TestingApplication:
    __test__ = False

    def __init__(
        self,
        authorizer: Any,
        store: Any,
        engine: Any,
        resolver: Any,
        wiring: Any,
        plugins: list[Any] | None = None,
    ) -> None:
        self.authorizer, self.store, self.engine, self.resolver, self.wiring = (
            authorizer,
            store,
            engine,
            resolver,
            wiring,
        )
        self.plugins = plugins or []
        self._requests: dict[tuple[str, str], Record] = {}
        self._request_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._plan_notifier: Any = None
        self.batches = BatchCoordinator(self)

    def set_plan_notifier(self, notifier: Any) -> None:
        self._plan_notifier = notifier

    def set_batch_notifier(self, notifier: Any) -> None:
        self.batches.set_notifier(notifier)

    def _notify_items(self, event: Record) -> None:
        if self.batches.notifier:
            self.batches.notifier(event)

    @operation(
        "testing.listPlans",
        capability="testing.read",
        risk="read",
        profiles=("plan", "run"),
        idempotency="natural",
    )
    def list_plans(self, context: Record) -> list[Record]:
        return cast(list[Record], self.store.list())

    @operation(
        "testing.loadPlan",
        capability="testing.read",
        risk="read",
        profiles=("plan", "run"),
        idempotency="natural",
    )
    def load_plan(self, context: Record, plan_id: str) -> Record:
        return cast(Record, self.store.load(plan_id))

    @operation(
        "testing.createPlan",
        capability="testing.manage",
        risk="write",
        profiles=("plan",),
        idempotency="request-id",
    )
    async def create_plan(self, context: Record, input: Record) -> Record:
        request_id = _request_id(input)
        async with self._lock_for("create", request_id):
            cached = await self._claim_request("create", request_id, input)
            if cached:
                return cached
            try:
                result = cast(Record, await self.store.create(input))
            except BaseException:
                await self.store.release_request("create", request_id)
                raise
            await self._complete_request("create", request_id, result)
            self._notify_plan(result["plan"], "created")
            return result

    @operation(
        "testing.savePlan",
        capability="testing.manage",
        risk="write",
        profiles=("plan",),
        idempotency="natural",
    )
    async def save_plan(self, context: Record, plan: Record, base_revision: int) -> Record:
        """Replace a saved plan with a complete plan document at ``baseRevision``. Prefer
        apply_test_plan_operations for edits; this is for the operator's editor."""
        result = cast(Record, await self.store.save(plan, base_revision))
        self._notify_plan(result["plan"], "saved")
        return result

    @operation(
        "testing.deletePlan",
        capability="testing.manage",
        risk="destructive",
        profiles=("plan",),
        idempotency="natural",
        confirm=True,
    )
    async def delete_plan(self, context: Record, plan_id: str) -> Record:
        """Delete a saved test plan and its file; the operator confirms it first. A running plan
        cannot be deleted."""
        if self.engine.active and self.engine.active.plan["id"] == plan_id:
            raise app_error("conflict", "Cannot delete the active test plan")
        result = cast(Record, await self.store.delete(plan_id))
        self._notify_plan({"id": plan_id}, "deleted")
        return result

    @operation(
        "testing.applyPlanOperations",
        capability="testing.manage",
        risk="write",
        profiles=("plan",),
        idempotency="request-id",
    )
    async def apply_plan_operations(self, context: Record, input: Record) -> Record:
        request_id = _request_id(input)
        async with self._lock_for("operations", request_id):
            cached = await self._claim_request("operations", request_id, input)
            if cached:
                return cached
            try:
                result = cast(
                    Record,
                    await self.store.apply_operations(
                        str(input["planId"]),
                        int(input["baseRevision"]),
                        list(input.get("operations", [])),
                    ),
                )
            except BaseException:
                await self.store.release_request("operations", request_id)
                raise
            await self._complete_request("operations", request_id, result)
            self._notify_plan(result["plan"], "updated")
            return result

    @operation(
        "testing.validatePlan",
        capability="testing.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def validate_plan(self, context: Record, plan_id: str) -> Record:
        return cast(Record, self.store.validate(plan_id))

    @operation(
        "testing.analyzePlanDraft",
        capability="testing.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def analyze_plan_draft(self, context: Record, input: Record) -> Record:
        """Validate an unsaved plan draft against current devices without saving it."""
        return cast(
            Record,
            self.store.analyze(cast(Record, input["plan"]), int(input["baseRevision"])),
        )

    @operation(
        "testing.listStepCatalog",
        capability="testing.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def list_step_catalog(self, context: Record) -> list[Record]:
        return step_catalog(self.plugins)

    @operation(
        "testing.listDeviceTools",
        capability="testing.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def list_device_tools(self, context: Record, hardware_id: str) -> Record:
        return cast(Record, self.resolver.list_device_tools(hardware_id))

    @operation(
        "testing.listIcds",
        capability="testing.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def list_icds(self, context: Record) -> list[Record]:
        return cast(list[Record], self._icds().list())

    @operation(
        "testing.readIcd",
        capability="testing.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def read_icd(self, context: Record, name: str) -> Record:
        library = self._icds()
        result: Record = {"name": name, "text": library.read_text(name)}
        try:
            result.update(valid=True, icd=describe_icd(library.load(name)))
        except AppError as error:
            result.update(valid=False, error=str(error), issues=_issues(error))
        return result

    @operation(
        "testing.saveIcd",
        capability="testing.manage",
        risk="write",
        profiles=("plan",),
        idempotency="natural",
    )
    async def save_icd(self, context: Record, input: Record) -> Record:
        """Write ``icd/<name>.icd.yaml``; an invalid ICD is rejected and nothing is written."""
        name, text = str(input["name"]), str(input["text"])
        icd = await asyncio.to_thread(self._icds().save_text, name, text)
        return {"name": name, "icd": describe_icd(icd)}

    @operation(
        "testing.checkIcd",
        capability="testing.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def check_icd(self, context: Record, input: Record) -> Record:
        """Validate ICD text (unsaved or ``name``'s file) and trial-decode sample records."""
        alias = input.get("alias") or None
        try:
            text = input.get("text")
            icd = (
                load_icd(str(text))
                if isinstance(text, str)
                else self._icds().load(str(input["name"]))
            )
        except AppError as error:
            if error.category not in {"invalid_argument", "validation_failed"}:
                raise
            return {"valid": False, "error": str(error), "issues": _issues(error)}
        result: Record = {"valid": True, "icd": describe_icd(icd, alias)}
        samples = input.get("samples")
        if isinstance(samples, list) and samples:
            result["decoded"] = trial_decode(icd, samples, alias)
        return result

    def _icds(self) -> Any:
        library = getattr(self.resolver, "icds", None)
        if library is None:
            raise app_error("unavailable", "The ICD library is not available")
        return library

    @operation(
        "testing.startRun",
        capability="testing.execute",
        risk="actuate",
        profiles=("run",),
        idempotency="request-id",
    )
    async def start_run(self, context: Record, input: Record) -> Record:
        request_id = _request_id(input)
        async with self._lock_for("start", request_id):
            cached = await self._claim_request("start", request_id, input)
            if cached:
                return cached
            try:
                plan = self.store.load(str(input["planId"]))
                if plan["revision"] != int(input["revision"]):
                    raise app_error(
                        "conflict",
                        "Test plan revision changed",
                        {"currentRevision": plan["revision"]},
                    )
                parameters = _parameters(plan, input.get("parameters", {}))
                compiled = self.store.compile(plan["id"], parameters)
                if self.batches.running:
                    raise app_error("conflict", "A batch run is in progress")
                if compiled["executionRevision"] != str(input.get("executionRevision", "")):
                    raise app_error(
                        "conflict",
                        "Validated execution inputs changed; validate the plan again",
                        {
                            "executionRevision": compiled["executionRevision"],
                            "revision": plan["revision"],
                        },
                    )
                result = await self._start_compiled(plan, compiled, parameters)
            except BaseException:
                await self.store.release_request("start", request_id)
                raise
            await self._complete_request("start", request_id, result)
            return result

    async def start_item(
        self, plan_id: str, batch_id: str, station: Record | None = None
    ) -> Record:
        """Start one batch item at its latest saved revision; ``station`` overrides defaults."""
        plan, parameters, compiled = self.compile_item(plan_id, station)
        return await self._start_compiled(plan, compiled, parameters, batch_id)

    def compile_item(
        self, plan_id: str, station: Record | None = None
    ) -> tuple[Record, Record, Record]:
        """The saved plan, its run parameters for ``station`` and the plan compiled for them."""
        plan = self.store.load(plan_id)
        parameters = _parameters(plan, station or {})
        return plan, parameters, self.store.compile(plan_id, parameters)

    async def _start_compiled(
        self, plan: Record, compiled: Record, parameters: Record, batch_id: str | None = None
    ) -> Record:
        if not compiled["valid"]:
            raise app_error(
                "validation_failed",
                "Test plan has validation errors",
                {"issues": compiled["issues"], "revision": plan["revision"]},
            )
        self.check_wiring_gate(compiled["compiledPlan"])
        tags = {"unitId": self.ensure_unit()["unitId"], "batchId": batch_id}
        return cast(
            Record,
            await self.engine.start(
                compiled["compiledPlan"], parameters, compiled["executionRevision"], tags
            ),
        )

    def check_wiring_gate(self, plan: Record) -> None:
        hardware_ids = plan_hardware_ids(plan)
        pending = self.wiring.list_tasks({"limit": 500})
        if any(
            task.get("status") in {"pending", "in_progress"}
            and _touches_hardware(task, hardware_ids)
            for task in pending
        ):
            raise app_error(
                "conflict",
                "A wiring task for this plan's hardware is awaiting confirmation",
            )

    def check_recovery_gate(self, plan: Record) -> None:
        self.store.runtime.initialize()
        blocked = {
            item["hardwareId"] for item in self.store.runtime.operations(recovery_only=True)
        } & set(plan_hardware_ids(plan))
        if blocked:
            raise app_error(
                "conflict",
                "Hardware has unresolved physical operations",
                {"hardwareIds": sorted(blocked), "recoveryRequired": True},
            )

    # Units under test: a project tests one product; each physical unit is one round.

    def ensure_unit(self) -> Record:
        unit = self.store.runtime.get_metadata(_UNIT_KEY)
        if isinstance(unit, dict) and unit.get("unitId"):
            return cast(Record, unit)
        unit = {"unitId": new_uuid(), "serialNumber": "", "startedAt": utc_now_iso()}
        self.store.runtime.set_metadata(_UNIT_KEY, unit)
        self._notify_items({"kind": "unit", "unit": unit})
        return unit

    @operation(
        "testing.currentUnit",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def current_unit(self, context: Record) -> Record:
        """The current unit under test (serial number and attributes) runs are recorded for."""
        return self.ensure_unit()

    # Functional test items: one saved plan per item, ordered per project.

    @operation(
        "testing.listItemStatus",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def list_item_status(self, context: Record) -> Record:
        unit = self.ensure_unit()
        plans = cast(list[Record], self.store.list())
        latest: dict[str, Record] = {}
        for run in self.store.runtime.run_snapshots():
            if run.get("unitId") != unit["unitId"]:
                continue
            plan_id = str(run.get("planId"))
            previous = latest.get(plan_id)
            if not previous or str(run.get("startedAt", "")) > str(previous.get("startedAt", "")):
                latest[plan_id] = run
        active = self.engine.active if self.engine.active and not self.engine.active.done else None
        batch = self.batches.snapshot() if self.batches.running else None
        queued = {
            item["planId"] for item in (batch or {}).get("items", []) if item["state"] == "queued"
        }
        items = []
        for plan in _ordered(plans, self.store.runtime.get_metadata(_ORDER_KEY)):
            run = latest.get(plan["id"])
            if active and active.plan["id"] == plan["id"]:
                run = active.snapshot()
            items.append(_item_status(plan, run, plan["id"] in queued))
        return {"unit": unit, "items": items, **({"batch": batch} if batch else {})}

    @operation(
        "testing.reorderItems",
        capability="testing.manage",
        risk="write",
        profiles=("plan",),
        idempotency="natural",
    )
    def reorder_items(self, context: Record, input: Record) -> Record:
        """Set the order of the test plans in the test tree (and of a batch run): ``planIds``
        first, in this order; returns the item statuses."""
        self.store.runtime.set_metadata(_ORDER_KEY, list(dict.fromkeys(_plan_ids(input))))
        self._notify_items({"kind": "order"})
        return self.list_item_status(context)

    # Batch runs execute selected items one after another.

    @operation(
        "testing.startBatch",
        capability="testing.execute",
        risk="actuate",
        profiles=("run",),
        idempotency="request-id",
    )
    async def start_batch(self, context: Record, input: Record) -> Record:
        request_id = _request_id(input)
        async with self._lock_for("batch", request_id):
            cached = await self._claim_request("batch", request_id, input)
            if cached:
                return cached
            try:
                stop_on_fail = bool(input.get("stopOnFail", False))
                result = await self.batches.start(_plan_ids(input), stop_on_fail, _stations(input))
            except BaseException:
                await self.store.release_request("batch", request_id)
                raise
            await self._complete_request("batch", request_id, result)
            return result

    @operation(
        "testing.abortBatch",
        capability="testing.execute",
        risk="actuate",
        profiles=("run",),
    )
    async def abort_batch(self, context: Record, batch_id: str) -> Record:
        return await self.batches.abort(batch_id)

    @operation(
        "testing.currentBatch",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def current_batch(self, context: Record) -> Record | None:
        """The active or latest batch run of several test items, or null."""
        return self.batches.current()

    @operation(
        "testing.getBatch",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def get_batch(self, context: Record, batch_id: str) -> Record:
        """One batch run with the state and verdict of each of its items."""
        return self.batches.get(batch_id)

    @operation(
        "testing.waitForBatch",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    async def wait_for_batch(
        self, context: Record, batch_id: str, timeout_ms: int = 30_000
    ) -> Record:
        return await self.batches.wait(batch_id, min(max(int(timeout_ms), 1), 30_000))

    @operation("testing.pauseRun", capability="testing.execute", risk="actuate", profiles=("run",))
    async def pause_run(self, context: Record, run_id: str) -> Record:
        return cast(Record, await self.engine.pause(run_id))

    @operation("testing.resumeRun", capability="testing.execute", risk="actuate", profiles=("run",))
    async def resume_run(self, context: Record, run_id: str) -> Record:
        return cast(Record, await self.engine.resume(run_id))

    @operation("testing.abortRun", capability="testing.execute", risk="actuate", profiles=("run",))
    async def abort_run(self, context: Record, run_id: str) -> Record:
        return cast(Record, await self.engine.abort(run_id))

    @operation(
        "testing.currentRun",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def current_run(self, context: Record) -> Record | None:
        """The active or latest test run, or null."""
        return cast(Record | None, self.engine.current())

    @operation(
        "testing.getRun",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def get_run(self, context: Record, run_id: str) -> Record:
        result = cast(Record | None, self.engine.get(run_id))
        if not result:
            raise app_error("not_found", f"Test run not found: {run_id}")
        return result

    @operation(
        "testing.listRuns",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def list_runs(self, context: Record, input: Record | None = None) -> Record:
        query = input or {}
        return cast(
            Record,
            self.store.runtime.list_runs(
                cursor=query.get("cursor"),
                limit=int(query.get("limit", 50)),
                plan_id=query.get("planId"),
                verdict=query.get("verdict"),
                state=query.get("state"),
                from_at=query.get("from"),
                to_at=query.get("to"),
            ),
        )

    @operation(
        "testing.readRunLog",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def read_run_log(
        self,
        context: Record,
        run_id: str,
        after_event_sequence: int = 0,
        after_result_sequence: int = 0,
        event_limit: int = 1000,
        result_limit: int = 1000,
    ) -> Record:
        return cast(
            Record,
            self.engine.read_log(
                run_id,
                after_event_sequence,
                after_result_sequence,
                event_limit,
                result_limit,
            ),
        )

    @operation(
        "testing.readRunResults",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def read_run_results(self, context: Record, run_id: str, after_sequence: int = 0) -> Record:
        return cast(Record, self.engine.read_results(run_id, after_sequence))

    @operation(
        "testing.listRunStreams",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def list_run_streams(self, context: Record, run_id: str) -> Record:
        """The data streams recorded during a run, with their keys for readRunStream."""
        return cast(Record, self.engine.list_run_streams(run_id))

    @operation(
        "testing.readRunStream",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def read_run_stream(
        self, context: Record, run_id: str, key: str, query: Record | None = None
    ) -> Record:
        """Records of one run stream, by key from listRunStreams, optionally windowed."""
        return cast(Record, self.engine.read_run_stream(run_id, key, query or {}))

    @operation(
        "testing.getRunTimeline",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def get_run_timeline(self, context: Record, run_id: str) -> Record:
        """Each step execution of a run with its start/end time and outcome."""
        return cast(Record, self.engine.get_run_timeline(run_id))

    @operation(
        "testing.readRunMessages",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def read_run_messages(
        self, context: Record, run_id: str, query: Record | None = None
    ) -> Record:
        return cast(Record, self.engine.read_run_messages(run_id, query or {}))

    @operation(
        "testing.readRunIo",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def read_run_io(
        self, context: Record, run_id: str, step_id: str | None = None, limit: int = 50
    ) -> Record:
        return cast(Record, self.engine.read_run_io(run_id, step_id, limit))

    @operation(
        "testing.rejudgeRun",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def rejudge_run(self, context: Record, run_id: str) -> Record:
        """Judge a finished run's recordings again with the current assertions; the stored
        verdict is not changed."""
        return cast(Record, self.engine.rejudge_run(run_id))

    @operation(
        "testing.waitForRun",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    async def wait_for_run(
        self, context: Record, run_id: str, after_sequence: int = 0, timeout_ms: int = 30_000
    ) -> Record:
        return cast(Record, await self.engine.wait(run_id, after_sequence, timeout_ms))

    @operation(
        "testing.listRecoveryItems",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def list_recovery_items(self, context: Record) -> list[Record]:
        self.store.runtime.initialize()
        return cast(list[Record], self.store.runtime.operations(recovery_only=True))

    @operation("testing.answerManualCheck", capability="testing.judge", risk="actuate")
    def answer_manual_check(self, context: Record, input: Record) -> Record:
        """The operator's answer to a waiting ``ManualCheck`` (design §7.2); never an Agent's."""
        operator = str(input.get("operator") or "").strip() or _login_name()
        return cast(
            Record,
            self.engine.answer_manual_check(
                str(input.get("runId", "")),
                str(input.get("executionId", "")),
                str(input.get("option", "")),
                str(input.get("note") or ""),
                operator,
            ),
        )

    @operation(
        "testing.reconcileOperation",
        capability="testing.execute",
        risk="write",
        profiles=("run",),
        confirm=True,
    )
    async def reconcile_operation(self, context: Record, input: Record) -> Record:
        operation_id = str(input.get("operationId", ""))
        items = [
            item
            for item in self.store.runtime.operations(recovery_only=True)
            if item["operationId"] == operation_id
        ]
        if not items:
            raise app_error("not_found", f"Recovery operation not found: {operation_id}")
        resolution = input.get("resolution")
        if resolution not in {"confirmed_succeeded", "confirmed_failed", "safe_state_restored"}:
            raise app_error(
                "invalid_argument", "A supported explicit recovery resolution is required"
            )
        operation = items[0]
        update = {
            "recoveryRequired": False,
            "resolvedAt": utc_now_iso(),
            "result": {"resolution": resolution, "note": input.get("note", "")},
        }
        if resolution == "confirmed_succeeded":
            update.update({"state": "succeeded", "outcomeKnown": True})
        elif resolution == "confirmed_failed":
            update.update({"state": "failed", "outcomeKnown": True})
        self.store.runtime.update_operation(operation_id, **update)
        run = self.engine.reconcile_run(str(operation["runId"]), operation_id, str(resolution))
        reconciled = next(
            item for item in self.store.runtime.operations() if item["operationId"] == operation_id
        )
        return {"operation": reconciled, "run": run}

    async def close(self) -> None:
        await self.batches.close()
        if self.engine.active and not self.engine.active.done:
            await self.engine.abort(self.engine.active.run_id)
            if self.engine.active.task:
                await self.engine.active.task

    def _notify_plan(self, plan: Record, change: str) -> None:
        if self._plan_notifier:
            self._plan_notifier(
                {"change": change, "planId": plan["id"], "revision": plan.get("revision")}
            )

    def _lock_for(self, scope: str, request_id: str) -> asyncio.Lock:
        return self._request_locks.setdefault((scope, request_id), asyncio.Lock())

    async def _claim_request(self, scope: str, request_id: str, payload: Record) -> Record | None:
        key = (scope, request_id)
        entry = cast(Record | None, await self.store.claim_request(scope, request_id, payload))
        if entry is None:
            return None
        if entry.get("state") == "completed" and isinstance(entry.get("result"), dict):
            result = cast(Record, clone(entry["result"]))
            self._requests[key] = clone(result)
            return result
        raise app_error(
            "conflict",
            "The request is already pending; its outcome may be unknown",
            {"requestId": request_id, "scope": scope, "outcomeKnown": False},
        )

    async def _complete_request(self, scope: str, request_id: str, result: Record) -> None:
        await self.store.complete_request(scope, request_id, result)
        self._requests[(scope, request_id)] = clone(result)


def _plan_ids(input: Record) -> list[str]:
    plan_ids = input.get("planIds")
    if not isinstance(plan_ids, list) or not all(isinstance(item, str) for item in plan_ids):
        raise app_error("invalid_argument", "planIds must be a list of plan ids")
    return cast(list[str], plan_ids)


def _stations(input: Record) -> list[Record] | None:
    stations = input.get("stations")
    if stations is None:
        return None
    if (
        not isinstance(stations, list)
        or not stations
        or not all(isinstance(item, dict) for item in stations)
    ):
        raise app_error("invalid_argument", "stations must be a non-empty list of objects")
    return cast(list[Record], stations)


def _ordered(plans: list[Record], order: Any) -> list[Record]:
    rank = {
        plan_id: index for index, plan_id in enumerate(order if isinstance(order, list) else [])
    }
    return sorted(
        plans,
        key=lambda plan: (rank.get(plan["id"], len(rank)), str(plan.get("name", "")).lower()),
    )


def _item_status(plan: Record, run: Record | None, queued: bool) -> Record:
    item: Record = {
        "planId": plan["id"],
        "name": plan.get("name", plan["id"]),
        "revision": plan.get("revision", 0),
        "invalid": bool(plan.get("invalid", False)),
        "queued": queued,
        "stale": False,
    }
    if not run:
        return item
    item.update(
        {
            "runId": run["runId"],
            "state": run.get("state"),
            "verdict": run.get("verdict", "NotSet"),
            "startedAt": run.get("startedAt"),
            "stale": run.get("revision") != plan.get("revision"),
        }
    )
    if run.get("completedAt"):
        item["completedAt"] = run["completedAt"]
        with contextlib.suppress(ValueError, TypeError):
            started = datetime.fromisoformat(str(run["startedAt"]).replace("Z", "+00:00"))
            completed = datetime.fromisoformat(str(run["completedAt"]).replace("Z", "+00:00"))
            item["durationMs"] = max(0, int((completed - started).total_seconds() * 1000))
    error = run.get("primaryError")
    if isinstance(error, dict) and error.get("message"):
        item["message"] = str(error["message"])
    return item


def _touches_hardware(task: Record, hardware_ids: list[str]) -> bool:
    ports = [str(task.get("portA", "")), str(task.get("portB", ""))]
    return any(port.startswith(hardware_id + ".") for port in ports for hardware_id in hardware_ids)


def _request_id(value: Record) -> str:
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not request_id.strip():
        raise app_error("invalid_argument", "requestId is required")
    return request_id.strip()


def _issues(error: AppError) -> list[Record]:
    """``[{path, message}]`` of an ICD validation error (empty for a YAML syntax error)."""
    details = error.details if isinstance(error.details, dict) else {}
    return [dict(item) for item in details.get("issues", []) if isinstance(item, dict)]


def _parameters(plan: Record, provided: Any) -> Record:
    if not isinstance(provided, dict):
        raise app_error("invalid_argument", "Run parameters must be an object")
    output: Record = {}
    for item in plan.get("parameters", []):
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        name = item["name"]
        if name in provided:
            value = provided[name]
        elif "default" in item:
            value = clone(item["default"])
        elif item.get("required", False):
            raise app_error("invalid_argument", f"Missing required run parameter {name}")
        else:
            value = None
        parameter_type = item.get("type")
        if (
            parameter_type
            and value is not None
            and (
                not _matches_parameter_type(str(parameter_type), value)
                or parameter_type in {"number", "integer"}
                and isinstance(value, bool)
            )
        ):
            raise app_error("invalid_argument", f"Run parameter {name} has the wrong type")
        output[name] = value
    unknown = set(provided) - set(output)
    if unknown:
        raise app_error("invalid_argument", f"Unknown run parameters: {', '.join(sorted(unknown))}")
    return output


def _matches_parameter_type(parameter_type: str, value: Any) -> bool:
    if parameter_type == "string":
        return isinstance(value, str)
    if parameter_type == "number":
        return isinstance(value, (int, float))
    if parameter_type == "integer":
        return isinstance(value, int)
    if parameter_type == "boolean":
        return isinstance(value, bool)
    if parameter_type == "array":
        return isinstance(value, list)
    if parameter_type == "object":
        return isinstance(value, dict)
    return True


def _login_name() -> str:
    """Who answers a manual check when the interface names nobody: the OS login."""
    try:
        return getpass.getuser()
    except Exception:
        return "operator"
