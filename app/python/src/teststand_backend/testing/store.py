from __future__ import annotations

import asyncio
import builtins
import json
import os
import re
import tempfile
from collections.abc import MutableMapping, MutableSequence
from pathlib import Path
from typing import Any, cast

from ruamel.yaml import YAML
from ruamel.yaml.tokens import TagToken

from teststand_backend.contracts.errors import app_error
from teststand_backend.util import clone, new_uuid, utc_now_iso

from .compiler import analyze_plan_draft, compile_plan
from .models import STEP_ID, empty_plan, iter_steps
from .runtime_state import RuntimeStateStore
from .validation import validate_plan

Record = dict[str, Any]
PLAN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class TestPlanStore:
    __test__ = False

    def __init__(
        self,
        projects: Any,
        resolver: Any,
        plugins: list[Any] | None = None,
        wiring: Any | None = None,
    ) -> None:
        self.projects, self.resolver = projects, resolver
        self.plugins = plugins or []
        self.wiring = wiring
        self.runtime = RuntimeStateStore(projects)
        self._lock = asyncio.Lock()
        self._request_lock = asyncio.Lock()
        self._yaml = YAML(typ="rt")
        self._yaml.default_flow_style = False
        self._yaml.allow_duplicate_keys = False
        self._yaml.indent(mapping=2, sequence=4, offset=2)

    def directory(self) -> Path:
        session = self.projects.session()
        if not session:
            raise app_error("requires_project", "requires_project")
        return Path(session["rootPath"]) / ".teststand" / "plans"

    def request_ledger_path(self) -> Path:
        return self.directory().parent / "testing-requests.json"

    async def claim_request(
        self, scope: str, request_id: str, payload: Any | None = None
    ) -> Record | None:
        """Persist a request claim before side effects so retries cannot duplicate them."""
        async with self._request_lock:
            await asyncio.to_thread(self.runtime.initialize)
            return cast(
                Record | None,
                await asyncio.to_thread(
                    self.runtime.claim_request,
                    scope,
                    request_id,
                    payload if payload is not None else {},
                ),
            )

    async def complete_request(self, scope: str, request_id: str, result: Record) -> None:
        async with self._request_lock:
            await asyncio.to_thread(self.runtime.initialize)
            await asyncio.to_thread(self.runtime.complete_request, scope, request_id, result)

    async def release_request(self, scope: str, request_id: str) -> None:
        """Release claims for operations that failed before returning a result."""
        async with self._request_lock:
            await asyncio.to_thread(self.runtime.initialize)
            await asyncio.to_thread(self.runtime.release_request, scope, request_id)

    def list(self) -> list[Record]:
        directory = self.directory()
        if not directory.exists():
            return []
        output = []
        for path in sorted(directory.glob("*.hhplan.yaml"), key=lambda item: item.name.lower()):
            try:
                plan = self._read(path)
                output.append(self._summary(plan))
            except Exception as error:
                output.append(
                    {
                        "id": path.name.removesuffix(".hhplan.yaml"),
                        "name": path.name,
                        "revision": 0,
                        "invalid": True,
                        "message": str(error),
                    }
                )
        return output

    def load(self, plan_id: str) -> Record:
        path = self._path(plan_id)
        if not path.exists():
            raise app_error("not_found", f"Test plan not found: {plan_id}")
        return clone(self._read(path))

    async def create(self, value: Record) -> Record:
        async with self._lock:
            plan_id = str(value.get("id") or new_uuid())
            path = self._path(plan_id)
            if path.exists():
                raise app_error("conflict", f"Test plan already exists: {plan_id}")
            plan = empty_plan(str(value.get("name") or "Untitled test plan"), plan_id)
            for key in (
                "description",
                "parameters",
                "requirements",
                "stopOnFail",
                "protocolBindings",
                "bindings",
                "regions",
            ):
                if key in value:
                    plan[key] = clone(value[key])
            self._validate_structure(plan)
            await asyncio.to_thread(self._write, path, plan)
            return {
                "plan": clone(plan),
                "issues": validate_plan(plan, self.resolver, self.plugins),
            }

    async def save(self, plan: Record, base_revision: int) -> Record:
        async with self._lock:
            path = self._path(str(plan.get("id", "")))
            document = self._read_document(path)
            current = clone(document)
            if current.get("schemaVersion") != 2:
                raise app_error("conflict", "Only schemaVersion 2 plans can be edited")
            if current["revision"] != base_revision:
                raise app_error(
                    "conflict",
                    "Test plan revision changed",
                    {"currentRevision": current["revision"]},
                )
            next_plan = clone(plan)
            next_plan["revision"] = base_revision + 1
            next_plan["createdAt"] = current.get("createdAt", utc_now_iso())
            next_plan["updatedAt"] = utc_now_iso()
            _ensure_bindings_unchanged(current, next_plan)
            self._validate_structure(next_plan)
            merged = _merge_yaml(document, next_plan)
            await asyncio.to_thread(self._write, path, merged)
            return {
                "plan": next_plan,
                "issues": validate_plan(next_plan, self.resolver, self.plugins),
            }

    async def apply_operations(
        self, plan_id: str, base_revision: int, operations: builtins.list[Record]
    ) -> Record:
        async with self._lock:
            path = self._path(plan_id)
            document = self._read_document(path)
            plan = cast(Record, document)
            if plan.get("schemaVersion") != 2:
                raise app_error("conflict", "Only schemaVersion 2 plans can be edited")
            if plan["revision"] != base_revision:
                raise app_error(
                    "conflict", "Test plan revision changed", {"currentRevision": plan["revision"]}
                )
            for operation in operations:
                _apply_operation(plan, operation, self.resolver)
            plan["revision"] = base_revision + 1
            plan["updatedAt"] = utc_now_iso()
            plain_plan = clone(plan)
            self._validate_structure(plain_plan)
            await asyncio.to_thread(self._write, path, plan)
            return {
                "plan": plain_plan,
                "issues": validate_plan(plain_plan, self.resolver, self.plugins),
                "appliedOperations": len(operations),
            }

    async def delete(self, plan_id: str) -> Record:
        async with self._lock:
            path = self._path(plan_id)
            if not path.exists():
                raise app_error("not_found", f"Test plan not found: {plan_id}")
            await asyncio.to_thread(path.unlink)
            return {"planId": plan_id}

    def validate(self, plan_id: str) -> Record:
        plan = self.load(plan_id)
        compiled = compile_plan(plan, self.resolver, self.plugins, self.wiring)
        issues = compiled["issues"]
        return {
            "planId": plan_id,
            "revision": plan["revision"],
            "valid": not any(item["severity"] == "error" for item in issues),
            "issues": issues,
            "executionRevision": compiled["executionRevision"],
            "wiringRevision": compiled["wiringRevision"],
            "coverage": compiled["coverage"],
        }

    def compile(self, plan_id: str, values: Record | None = None) -> Record:
        return compile_plan(self.load(plan_id), self.resolver, self.plugins, self.wiring, values)

    def analyze(self, plan: Record, base_revision: int) -> Record:
        current = self.load(str(plan.get("id", "")))
        if int(current.get("revision", 0)) != int(base_revision):
            raise app_error(
                "conflict",
                "Test plan revision changed",
                {"currentRevision": current.get("revision")},
            )
        self._validate_structure(clone(plan))
        return analyze_plan_draft(clone(plan), self.resolver, self.plugins, self.wiring)

    def _path(self, plan_id: str) -> Path:
        if not PLAN_ID.fullmatch(plan_id):
            raise app_error("invalid_argument", "Invalid test plan id")
        return self.directory() / f"{plan_id}.hhplan.yaml"

    def _read(self, path: Path) -> Record:
        return cast(Record, clone(self._read_document(path)))

    def _read_document(self, path: Path) -> Any:
        text = path.read_text(encoding="utf-8")
        if any(isinstance(token, TagToken) for token in self._yaml.scan(text)):
            raise app_error("invalid_argument", "Custom YAML tags are not allowed")
        value = self._yaml.load(text)
        if not isinstance(value, dict):
            raise app_error("invalid_argument", "Test plan YAML must contain an object")
        self._validate_structure(cast(Record, clone(value)))
        return value

    def _write(self, path: Path, plan: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                self._yaml.dump(plan, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _read_request_ledger(self) -> Record:
        path = self.request_ledger_path()
        if not path.exists():
            return {"version": 1, "requests": {}}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise app_error("invalid_argument", "Testing request ledger is invalid") from error
        if (
            not isinstance(value, dict)
            or value.get("version") != 1
            or not isinstance(value.get("requests"), dict)
        ):
            raise app_error("invalid_argument", "Testing request ledger is invalid")
        return cast(Record, value)

    def _write_request_ledger(self, ledger: Record) -> None:
        path = self.request_ledger_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(ledger, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _validate_structure(self, plan: Record) -> None:
        if (
            plan.get("schemaVersion") != 2
            or not isinstance(plan.get("id"), str)
            or not PLAN_ID.fullmatch(plan["id"])
        ):
            raise app_error("invalid_argument", "Invalid test plan structure")
        regions = plan.get("regions")
        if not isinstance(regions, dict) or any(
            not isinstance(regions.get(name), list) for name in ("prepare", "test", "cleanup")
        ):
            raise app_error(
                "invalid_argument", "Test plan requires prepare, test and cleanup arrays"
            )
        ids = [step.get("id") for _, step in iter_steps(plan)]
        if any(not isinstance(value, str) or not STEP_ID.fullmatch(value) for value in ids) or len(
            ids
        ) != len(set(ids)):
            raise app_error("invalid_argument", "Test step ids must be valid and unique")

    def _summary(self, plan: Record) -> Record:
        issues = validate_plan(plan, self.resolver, self.plugins)
        return {
            "id": plan["id"],
            "name": plan["name"],
            "description": plan.get("description", ""),
            "revision": plan["revision"],
            "updatedAt": plan.get("updatedAt"),
            "valid": not any(item["severity"] == "error" for item in issues),
            "stepCount": len(iter_steps(plan)),
        }


def _apply_operation(plan: Record, operation: Record, resolver: Any | None = None) -> None:
    kind = operation.get("type")
    if kind == "set_plan_fields":
        patch = operation.get("patch", {})
        for key in ("name", "description", "stopOnFail", "protocolBindings", "bindings"):
            if key in patch:
                plan[key] = clone(patch[key])
        return
    if kind == "set_parameters":
        plan["parameters"] = clone(operation.get("parameters", []))
        return
    if kind == "insert_step":
        target = _children(
            plan,
            operation.get("parentId"),
            str(operation.get("region", "test")),
            str(operation.get("branch", "children")),
        )
        index = int(operation.get("index", len(target)))
        inserted = clone(operation.get("step", {}))
        if (
            inserted.get("type") == "InvokeTool"
            and inserted.get("hardwareId")
            and inserted.get("toolName")
        ):
            _bind_step(inserted, str(inserted["hardwareId"]), str(inserted["toolName"]), resolver)
        target.insert(max(0, min(index, len(target))), inserted)
        return
    if kind == "update_step":
        step = _require_step(plan, str(operation.get("stepId", "")))[2]
        protected = {
            "id",
            "type",
            "children",
            "elseChildren",
            "hardwareId",
            "toolName",
            "bindingRevision",
            "toolContractRevision",
            "inputSchemaHash",
            "retryAllowed",
        }
        for key, value in operation.get("patch", {}).items():
            if key not in protected:
                step[key] = clone(value)
        return
    if kind in {"bind_invoke_tool", "refresh_invoke_binding"}:
        step = _require_step(plan, str(operation.get("stepId", "")))[2]
        if step.get("type") != "InvokeTool":
            raise app_error("invalid_argument", "Binding operations require an InvokeTool step")
        hardware_id = str(operation.get("hardwareId", step.get("hardwareId", "")))
        tool_name = str(operation.get("toolName", step.get("toolName", "")))
        _bind_step(step, hardware_id, tool_name, resolver)
        return
    if kind == "set_step_enabled":
        _require_step(plan, str(operation.get("stepId", "")))[2]["enabled"] = bool(
            operation.get("enabled", True)
        )
        return
    if kind == "remove_step":
        parent, index, _ = _require_step(plan, str(operation.get("stepId", "")))
        parent.pop(index)
        return
    if kind == "move_step":
        parent, index, step = _require_step(plan, str(operation.get("stepId", "")))
        parent.pop(index)
        target = _children(
            plan,
            operation.get("parentId"),
            str(operation.get("region", "test")),
            str(operation.get("branch", "children")),
        )
        target_index = max(0, min(int(operation.get("index", len(target))), len(target)))
        target.insert(target_index, step)
        return
    raise app_error("invalid_argument", f"Unknown test plan operation: {kind}")


def default_arguments(schema: Record) -> Record:
    """Values for the required parameters of a tool input schema: the declared default, else the
    first enum value, the minimum, ``False``, ``0`` or ``""``."""
    declared = schema.get("properties")
    properties: Record = declared if isinstance(declared, dict) else {}
    output: Record = {}
    for name in schema.get("required", []) if isinstance(schema.get("required"), list) else []:
        field = properties.get(name)
        if not isinstance(field, dict):
            continue
        kind = field.get("type")
        if "default" in field:
            output[name] = clone(field["default"])
        elif isinstance(field.get("enum"), list) and field["enum"]:
            output[name] = clone(field["enum"][0])
        elif kind in ("integer", "number"):
            output[name] = field.get("minimum", 0)
        elif kind == "boolean":
            output[name] = False
        elif kind == "string":
            output[name] = ""
    return output


def _bind_step(step: Record, hardware_id: str, tool_name: str, resolver: Any | None) -> None:
    if resolver is None:
        raise app_error("validation_failed", "Device tool resolver is unavailable")
    tool, issues = resolver.resolve(hardware_id, tool_name)
    if not tool:
        raise app_error("validation_failed", "Device tool binding is invalid", {"issues": issues})
    if step.get("toolName") != tool_name or not isinstance(step.get("arguments"), dict):
        # A new tool starts from its required parameters' defaults, so the step is runnable
        # as soon as it is bound; the user then changes what differs.
        step["arguments"] = default_arguments(tool.get("inputSchema", {}))
    step["hardwareId"] = hardware_id
    step["toolName"] = tool_name
    step["bindingRevision"] = tool["bindingRevision"]
    step.pop("toolContractRevision", None)
    step.pop("inputSchemaHash", None)
    step.pop("retryAllowed", None)


def _ensure_bindings_unchanged(current: Record, incoming: Record) -> None:
    old = {step.get("id"): step for _, step in iter_steps(current)}
    for _, step in iter_steps(incoming):
        previous = old.get(step.get("id"))
        if not previous or step.get("type") != "InvokeTool" or previous.get("type") != "InvokeTool":
            continue
        for key in ("hardwareId", "toolName", "bindingRevision"):
            if step.get(key) != previous.get(key):
                raise app_error(
                    "invalid_argument",
                    f"{key} can only be changed through an InvokeTool binding operation",
                    {"stepId": step.get("id"), "field": key},
                )


def _merge_yaml(target: Any, source: Any) -> Any:
    """Merge plain plan data into a round-trip YAML document without discarding comments."""
    if isinstance(target, MutableMapping) and isinstance(source, dict):
        for key in list(target):
            if key not in source:
                del target[key]
        for key, value in source.items():
            target[key] = _merge_yaml(target[key], value) if key in target else clone(value)
        return target
    if isinstance(target, MutableSequence) and isinstance(source, list):
        existing_by_id = {
            str(item["id"]): item
            for item in target
            if isinstance(item, MutableMapping) and isinstance(item.get("id"), str)
        }
        merged = [
            _merge_yaml(existing_by_id[str(item["id"])], item)
            if isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and str(item["id"]) in existing_by_id
            else clone(item)
            for item in source
        ]
        target[:] = merged
        return target
    return clone(source)


def _require_step(plan: Record, step_id: str) -> tuple[list[Record], int, Record]:
    def search(items: list[Record]) -> tuple[list[Record], int, Record] | None:
        for index, step in enumerate(items):
            if step.get("id") == step_id:
                return items, index, step
            for key in ("children", "elseChildren"):
                nested = search(step.get(key, []))
                if nested:
                    return nested
        return None

    for region in ("prepare", "test", "cleanup"):
        found = search(plan["regions"][region])
        if found:
            return found
    raise app_error("not_found", f"Test step not found: {step_id}")


def _children(plan: Record, parent_id: Any, region: str, branch: str) -> list[Record]:
    if parent_id is None:
        if region not in {"prepare", "test", "cleanup"}:
            raise app_error("invalid_argument", f"Unknown plan region: {region}")
        return cast(list[Record], plan["regions"][region])
    parent = _require_step(plan, str(parent_id))[2]
    if branch not in {"children", "elseChildren"}:
        raise app_error("invalid_argument", f"Unknown step branch: {branch}")
    value = parent.setdefault(branch, [])
    if not isinstance(value, list):
        raise app_error("invalid_argument", "Target step branch is not an array")
    return value
