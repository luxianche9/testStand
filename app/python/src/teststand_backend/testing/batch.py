"""Sequential batch runs over functional test items (one plan per item)."""

from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING, Any, cast

from teststand_backend.contracts.errors import app_error
from teststand_backend.util import clone, new_uuid, utc_now_iso

if TYPE_CHECKING:
    from .application import TestingApplication

Record = dict[str, Any]

# A batch always stops on these verdicts: the station state is no longer trustworthy.
_HARD_STOP_VERDICTS = {"Error", "Aborted"}


class BatchCoordinator:
    def __init__(self, testing: TestingApplication) -> None:
        self.testing = testing
        self.active: Record | None = None
        self.task: asyncio.Task[None] | None = None
        self.abort_requested = False
        self.notifier: Any = None

    @property
    def running(self) -> bool:
        return bool(self.active and self.active["state"] == "running")

    def set_notifier(self, notifier: Any) -> None:
        self.notifier = notifier

    def precheck(self, plan_ids: list[str], stations: list[Record] | None = None) -> list[Record]:
        """Return every reason the batch cannot start; an empty list means it can."""
        issues: list[Record] = []
        if self.running:
            issues.append({"message": "A batch is already running"})
        engine = self.testing.engine
        if engine.active and not engine.active.done:
            issues.append({"message": "A test run is already running"})
        if not plan_ids:
            issues.append({"message": "Select at least one test item"})
        if len(set(plan_ids)) != len(plan_ids):
            issues.append({"message": "A test item is selected more than once"})
        for plan_id in plan_ids:
            for station in stations or [{}]:
                where: Record = {"planId": plan_id, **({"station": station} if station else {})}
                try:
                    _, _, compiled = self.testing.compile_item(plan_id, station)
                    if not compiled["valid"]:
                        issues.append({**where, "message": "Test plan has validation errors"})
                        continue
                    self.testing.check_wiring_gate(compiled["compiledPlan"])
                    self.testing.check_recovery_gate(compiled["compiledPlan"])
                except Exception as error:
                    issues.append({**where, "message": str(getattr(error, "message", error))})
        return issues

    async def start(
        self, plan_ids: list[str], stop_on_fail: bool, stations: list[Record] | None = None
    ) -> Record:
        """Run every item in order; with ``stations`` (§7.6) each item runs once per station."""
        issues = self.precheck(plan_ids, stations)
        if issues:
            raise app_error("validation_failed", "Batch cannot start", {"issues": issues})
        items = []
        for plan_id in plan_ids:
            plan = self.testing.store.load(plan_id)
            for station in stations or [{}]:
                item: Record = {
                    "planId": plan_id,
                    "planName": plan.get("name", plan_id),
                    "state": "queued",
                }
                if station:
                    item["station"] = clone(station)
                items.append(item)
        self.abort_requested = False
        self.active = {
            "batchId": new_uuid(),
            "state": "running",
            "stopOnFail": stop_on_fail,
            "unitId": self.testing.ensure_unit()["unitId"],
            "startedAt": utc_now_iso(),
            "items": items,
        }
        self._persist()
        self.task = asyncio.create_task(self._execute())
        return self.snapshot()

    async def abort(self, batch_id: str) -> Record:
        if not self.active or self.active["batchId"] != batch_id:
            stored = self.get(batch_id)
            if stored["state"] == "running":
                raise app_error("conflict", "Batch is not owned by this session")
            return stored
        if self.active["state"] == "running":
            self.abort_requested = True
            engine = self.testing.engine
            if engine.active and not engine.active.done:
                await engine.abort(engine.active.run_id)
            self._persist()
        return self.snapshot()

    def snapshot(self) -> Record:
        return clone(self.active) if self.active else {}

    def current(self) -> Record | None:
        if self.active:
            return self.snapshot()
        return cast(Record | None, self.testing.store.runtime.latest_batch())

    def get(self, batch_id: str) -> Record:
        if self.active and self.active["batchId"] == batch_id:
            return self.snapshot()
        stored = cast(Record | None, self.testing.store.runtime.load_batch(batch_id))
        if not stored:
            raise app_error("not_found", f"Test batch not found: {batch_id}")
        return stored

    async def wait(self, batch_id: str, timeout_ms: int = 30_000) -> Record:
        if self.active and self.active["batchId"] == batch_id and self.task:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(self.task), timeout_ms / 1000)
        return self.get(batch_id)

    async def close(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task

    async def _execute(self) -> None:
        batch = cast(Record, self.active)
        stop_reason: str | None = None
        try:
            for item in batch["items"]:
                if stop_reason or self.abort_requested:
                    item["state"] = "skipped"
                    continue
                stop_reason = await self._run_item(batch, item)
                self._persist()
            if self.abort_requested:
                batch["state"] = "aborted"
            else:
                batch["state"] = "completed"
            if stop_reason:
                batch["stopReason"] = stop_reason
        except asyncio.CancelledError:
            batch["state"] = "aborted"
            raise
        except Exception as error:
            batch["state"] = "error"
            batch["stopReason"] = str(getattr(error, "message", error))
        finally:
            for item in batch["items"]:
                if item["state"] in {"queued", "running"}:
                    item["state"] = "skipped"
            batch.pop("currentPlanId", None)
            batch["completedAt"] = utc_now_iso()
            self._persist()

    async def _run_item(self, batch: Record, item: Record) -> str | None:
        """Run one item to completion and return a stop reason, if the batch must stop."""
        item["state"] = "running"
        batch["currentPlanId"] = item["planId"]
        self._persist()
        try:
            snapshot = await self.testing.start_item(
                item["planId"], batch["batchId"], item.get("station")
            )
        except Exception as error:
            item.update({"state": "done", "verdict": "Error"})
            item["message"] = str(getattr(error, "message", error))
            return f"{item['planName']}: {item['message']}"
        item["runId"] = snapshot["runId"]
        self._persist()
        run = self.testing.engine.runs.get(snapshot["runId"])
        if run and run.task:
            await asyncio.shield(run.task)
        final = self.testing.engine.get(snapshot["runId"]) or snapshot
        verdict = str(final.get("verdict", "NotSet"))
        item.update({"state": "done", "verdict": verdict})
        if verdict in _HARD_STOP_VERDICTS or not final.get("outcomeKnown", True):
            return f"{item['planName']}: {verdict}"
        if verdict == "Fail" and batch["stopOnFail"]:
            return f"{item['planName']}: Fail"
        return None

    def _persist(self) -> None:
        if not self.active:
            return
        self.testing.store.runtime.save_batch(self.active)
        if self.notifier:
            self.notifier({"kind": "batch", "batch": self.snapshot()})
