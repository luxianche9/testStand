from __future__ import annotations

import asyncio
from typing import Any, cast

from hardwareharness_backend.compat import clone
from hardwareharness_backend.contracts.errors import app_error

from .catalog import step_catalog

Record = dict[str, Any]


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

    def set_plan_notifier(self, notifier: Any) -> None:
        self._plan_notifier = notifier

    def list_plans(self, context: Record) -> list[Record]:
        self.authorizer.authorize(context, "testing.read")
        return cast(list[Record], self.store.list())

    def load_plan(self, context: Record, plan_id: str) -> Record:
        self.authorizer.authorize(context, "testing.read")
        return cast(Record, self.store.load(plan_id))

    async def create_plan(self, context: Record, input: Record) -> Record:
        self.authorizer.authorize(context, "testing.manage")
        request_id = _request_id(input)
        async with self._lock_for("create", request_id):
            cached = await self._claim_request("create", request_id)
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

    async def save_plan(self, context: Record, plan: Record, base_revision: int) -> Record:
        self.authorizer.authorize(context, "testing.manage")
        result = cast(Record, await self.store.save(plan, base_revision))
        self._notify_plan(result["plan"], "saved")
        return result

    async def delete_plan(self, context: Record, plan_id: str) -> Record:
        self.authorizer.authorize(context, "testing.manage")
        if self.engine.active and self.engine.active.plan["id"] == plan_id:
            raise app_error("conflict", "Cannot delete the active test plan")
        result = cast(Record, await self.store.delete(plan_id))
        self._notify_plan({"id": plan_id}, "deleted")
        return result

    async def apply_plan_operations(self, context: Record, input: Record) -> Record:
        self.authorizer.authorize(context, "testing.manage")
        request_id = _request_id(input)
        async with self._lock_for("operations", request_id):
            cached = await self._claim_request("operations", request_id)
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

    def validate_plan(self, context: Record, plan_id: str) -> Record:
        self.authorizer.authorize(context, "testing.read")
        return cast(Record, self.store.validate(plan_id))

    def list_step_catalog(self, context: Record) -> list[Record]:
        self.authorizer.authorize(context, "testing.read")
        return step_catalog(self.plugins)

    def list_device_tools(self, context: Record, hardware_id: str) -> Record:
        self.authorizer.authorize(context, "testing.read")
        return cast(Record, self.resolver.list_device_tools(hardware_id))

    async def start_run(self, context: Record, input: Record) -> Record:
        self.authorizer.authorize(context, "testing.execute")
        request_id = _request_id(input)
        async with self._lock_for("start", request_id):
            cached = await self._claim_request("start", request_id)
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
                validation = self.store.validate(plan["id"])
                if not validation["valid"]:
                    raise app_error(
                        "validation_failed",
                        "Test plan has validation errors",
                        {"issues": validation["issues"], "revision": plan["revision"]},
                    )
                pending = self.wiring.list_tasks({"limit": 500})
                if any(task.get("status") in {"pending", "in_progress"} for task in pending):
                    raise app_error("conflict", "A wiring task is awaiting confirmation")
                parameters = _parameters(plan, input.get("parameters", {}))
                result = cast(Record, await self.engine.start(plan, parameters))
            except BaseException:
                await self.store.release_request("start", request_id)
                raise
            await self._complete_request("start", request_id, result)
            return result

    async def pause_run(self, context: Record, run_id: str) -> Record:
        self.authorizer.authorize(context, "testing.execute")
        return cast(Record, await self.engine.pause(run_id))

    async def resume_run(self, context: Record, run_id: str) -> Record:
        self.authorizer.authorize(context, "testing.execute")
        return cast(Record, await self.engine.resume(run_id))

    async def abort_run(self, context: Record, run_id: str) -> Record:
        self.authorizer.authorize(context, "testing.execute")
        return cast(Record, await self.engine.abort(run_id))

    def current_run(self, context: Record) -> Record | None:
        self.authorizer.authorize(context, "testing.read")
        return cast(Record | None, self.engine.current())

    def get_run(self, context: Record, run_id: str) -> Record:
        self.authorizer.authorize(context, "testing.read")
        result = cast(Record | None, self.engine.get(run_id))
        if not result:
            raise app_error("not_found", f"Test run not found: {run_id}")
        return result

    def read_run_results(self, context: Record, run_id: str, after_sequence: int = 0) -> Record:
        self.authorizer.authorize(context, "testing.read")
        return cast(Record, self.engine.read_results(run_id, after_sequence))

    async def wait_for_run(
        self, context: Record, run_id: str, after_sequence: int = 0, timeout_ms: int = 30_000
    ) -> Record:
        self.authorizer.authorize(context, "testing.read")
        return cast(Record, await self.engine.wait(run_id, after_sequence, timeout_ms))

    async def close(self) -> None:
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

    async def _claim_request(self, scope: str, request_id: str) -> Record | None:
        key = (scope, request_id)
        cached = self._requests.get(key)
        if cached:
            return clone(cached)
        entry = cast(Record | None, await self.store.claim_request(scope, request_id))
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


def _request_id(value: Record) -> str:
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not request_id.strip():
        raise app_error("invalid_argument", "requestId is required")
    return request_id.strip()


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
