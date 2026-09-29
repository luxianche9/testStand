import asyncio
import hashlib
import json
import math
from collections.abc import Callable
from typing import Protocol

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.testing.runtime_state import RuntimeStateStore
from hardwareharness_backend.util import (
    Record,
    clone,
    iso_from_ms,
    new_uuid,
    now_ms,
    parse_date_ms,
    utc_now_iso,
)

# Edits of one connection within this window become one log entry.
COALESCE_MS = 60_000
CONNECTION_KEYS = ("portA", "portB", "pins")


class WiringProjectPort(Protocol):
    def wiring(self) -> Record: ...
    def document(self) -> Record: ...
    def update_wiring(self, wiring: Record) -> Record: ...


class WiringHardwareCatalogPort(Protocol):
    def get_hardware(self, hardware_id: str) -> Record: ...
    def resolve_port(self, port_ref: str) -> Record: ...
    def validate_pins(self, port_a: str, port_b: str, pins: list[Record]) -> None: ...
    def warnings_for_ports(self, port_a: str, port_b: str) -> list[str]: ...


class ProjectWiringService:
    def __init__(self, projects: WiringProjectPort, catalog: WiringHardwareCatalogPort) -> None:
        self.projects = projects
        self.catalog = catalog
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: dict[str, Record] = {}
        self._notifier: Callable[[Record], None] | None = None
        self._project_notifier: Callable[[], None] | None = None
        self._runtime = RuntimeStateStore(projects)
        self._last_changes: dict[str, Record] = {}

    def set_notifier(self, notifier: Callable[[Record], None]) -> None:
        self._notifier = notifier

    def set_project_notifier(self, notifier: Callable[[], None]) -> None:
        self._project_notifier = notifier

    async def initialize(self) -> None:
        session = getattr(self.projects, "session", lambda: None)()
        if not session:
            return
        await asyncio.to_thread(self._runtime.initialize)
        tasks = await asyncio.to_thread(self._runtime.load_wiring_tasks, str(session["projectId"]))
        self._tasks = {str(task["wiringTaskId"]): task for task in tasks}

    def clear_session(self) -> None:
        self._tasks.clear()
        self._last_changes.clear()

    async def add_managed_hardware_to_canvas(self, hardware_id: str) -> Record:
        async with self._lock("canvas:nodes"):
            identifier = hardware_id.strip()
            if not identifier:
                raise app_error("invalid_argument", "hardwareId is required")
            hardware = self.catalog.get_hardware(identifier)
            if hardware["kind"] != "managed":
                raise app_error(
                    "permission_denied",
                    f"Only managed hardware can be added by an Agent: {identifier}",
                )
            wiring = self.projects.wiring()
            existing = next(
                (node for node in wiring["nodes"] if node["hardwareId"] == identifier), None
            )
            if existing is not None:
                return {
                    "added": False,
                    "node": existing,
                    "dirty": self.projects.document()["dirty"],
                }
            index = len(wiring["nodes"])
            node = {
                "hardwareId": identifier,
                "x": 80 + (index % 3) * 330,
                "y": 80 + math.floor(index / 3) * 240,
                "width": 220,
                "height": 168,
                "showImage": True,
                "portPositions": default_port_positions(
                    [port["portId"] for port in hardware["ports"]]
                ),
            }
            document = self.projects.update_wiring(
                {"nodes": [*wiring["nodes"], node], "connections": wiring["connections"]}
            )
            if self._project_notifier:
                self._project_notifier()
            return {"added": True, "node": node, "dirty": document["dirty"]}

    async def request_task(self, input: Record) -> Record:
        references = [input[key].strip() for key in ("portA", "portB")]
        if not all(references):
            raise app_error("invalid_argument", "Two port references are required")
        endpoints = [self.catalog.resolve_port(reference) for reference in references]
        canonical = [
            f"{item['hardware']['hardwareId']}.{item['port']['portId']}" for item in endpoints
        ]
        port_a, port_b, pins = canonical_ports(canonical[0], canonical[1], input.get("pins", []))
        self.catalog.validate_pins(port_a, port_b, pins)
        hardware_ids = sorted(
            {
                self.catalog.resolve_port(port_a)["hardware"]["hardwareId"],
                self.catalog.resolve_port(port_b)["hardware"]["hardwareId"],
            }
        )
        timeout_ms = min(max(input.get("timeoutMs", 1_800_000), 1000), 86_400_000)
        now = now_ms()
        for existing in self._tasks.values():
            if existing["status"] not in ("pending", "in_progress"):
                continue
            if existing["portA"] == port_a and existing["portB"] == port_b:
                raise app_error(
                    "conflict",
                    "A pending wiring task already exists for this port pair",
                    {
                        "existingTaskId": existing["wiringTaskId"],
                        "status": existing["status"],
                        "recovery": "Read or cancel the existing task before requesting another.",
                    },
                )
        task = {
            "wiringTaskId": new_uuid(),
            "action": input["action"],
            "portA": port_a,
            "portB": port_b,
            "pins": pins,
            "hardwareIds": hardware_ids,
            "status": "pending",
            "requestedAt": iso_from_ms(now),
            "expiresAt": iso_from_ms(now + timeout_ms),
            "warnings": self.catalog.warnings_for_ports(port_a, port_b),
        }
        if input.get("requestedBy"):
            task["operatorName"] = input["requestedBy"]
        self._tasks[task["wiringTaskId"]] = task
        self._persist(task)
        self._emit(task)
        return clone(task)

    def validate_document_connections(self, wiring: Record) -> None:
        """Validate edited same-port pins while allowing layout edits of unresolved hardware."""
        previous = {item["connectionId"]: item for item in self.projects.wiring()["connections"]}
        for connection in wiring["connections"]:
            if connection["portA"] != connection["portB"]:
                continue
            old = previous.get(connection["connectionId"], {})
            if all(old.get(key) == connection.get(key) for key in ("portA", "portB", "pins")):
                continue
            port_a, port_b, pins = canonical_ports(
                connection["portA"], connection["portB"], connection.get("pins", [])
            )
            self.catalog.validate_pins(port_a, port_b, pins)

    async def start_task(self, wiring_task_id: str, operator_name: str = "operator") -> Record:
        async with self._lock(wiring_task_id):
            task = self.get_task(wiring_task_id)
            self._apply_lazy_timeout(task)
            if task["status"] != "pending":
                raise app_error("conflict", f"Wiring task is {task['status']}, not pending")
            started = {
                **task,
                "status": "in_progress",
                "startedAt": utc_now_iso(),
                "operatorName": operator_name.strip() or "operator",
            }
            self._tasks[wiring_task_id] = started
            self._persist(started)
            self._emit(started)
            return clone(started)

    async def complete_task(
        self, wiring_task_id: str, outcome: str, message: str | None = None
    ) -> Record:
        async with self._lock(wiring_task_id):
            task = self.get_task(wiring_task_id)
            if task["status"] not in ("pending", "in_progress"):
                raise app_error("conflict", f"Wiring task is {task['status']}, not in progress")
            if task["status"] == "pending":
                task = {**task, "operatorName": "operator"}
            if outcome == "confirmed":
                try:
                    self._apply_confirmed_wiring(task)
                except Exception as error:
                    return self._finish(task, "failed", f"Failed to update wiring: {error}")
            return self._finish(task, outcome, message)

    async def cancel_task(self, wiring_task_id: str, message: str | None = None) -> Record:
        async with self._lock(wiring_task_id):
            task = self.get_task(wiring_task_id)
            self._apply_lazy_timeout(task)
            if task["status"] not in ("pending", "in_progress"):
                return clone(task)
            return self._finish(task, "cancelled", message)

    def get_task(self, wiring_task_id: str) -> Record:
        task = self._tasks.get(wiring_task_id)
        if task is None:
            raise app_error(
                "not_found",
                f"Unknown wiringTaskId: {wiring_task_id}",
                {
                    "recovery": "Tasks are session-scoped. Read get_project for saved "
                    "connections and list_wiring_tasks for current tasks."
                },
            )
        self._apply_lazy_timeout(task)
        return clone(task)

    def list_tasks(self, input: Record | None = None) -> list[Record]:
        query = input or {}
        for task in list(self._tasks.values()):
            if task["status"] == "pending":
                self._apply_lazy_timeout(task)
        limit = min(max(query.get("limit", 100), 1), 500)
        items = [
            task
            for task in self._tasks.values()
            if "status" not in query or task["status"] == query["status"]
        ]
        items.sort(key=lambda task: task["requestedAt"], reverse=True)
        return [clone(task) for task in items[: int(limit)]]

    def record_manual_changes(self, previous: list[Record], current: list[Record]) -> list[Record]:
        """Log the operator's canvas edits to connections; layout-only edits leave no entry."""
        session = getattr(self.projects, "session", lambda: None)()
        if not session:
            return []
        project_id = str(session["projectId"])
        before = {item["connectionId"]: item for item in previous}
        after = {item["connectionId"]: item for item in current}
        now = utc_now_iso()
        entries: list[Record] = []
        for identifier in [*before, *(key for key in after if key not in before)]:
            old, new = before.get(identifier), after.get(identifier)
            if old and new and all(old.get(key) == new.get(key) for key in CONNECTION_KEYS):
                continue
            kind = "added" if old is None else "removed" if new is None else "changed"
            source = new or old
            assert source is not None
            entry: Record = {
                "entryId": new_uuid(),
                "kind": kind,
                "connectionId": identifier,
                "portA": source["portA"],
                "portB": source["portB"],
                "pins": clone(source.get("pins", [])),
                "at": now,
            }
            if kind == "changed" and old is not None:
                entry["previous"] = {
                    "portA": old["portA"],
                    "portB": old["portB"],
                    "pins": clone(old.get("pins", [])),
                }
            entries.append(self._coalesce(entry))
        self._runtime.initialize()
        for entry in entries:
            if entry.pop("dropped", False):
                self._runtime.delete_wiring_change(entry["entryId"])
                self._last_changes.pop(entry["connectionId"], None)
            else:
                self._runtime.save_wiring_change(project_id, entry)
                self._last_changes[entry["connectionId"]] = entry
        kept = [item for item in entries if self._last_changes.get(item["connectionId"]) is item]
        return [clone(entry) for entry in kept]

    def list_changes(self, input: Record | None = None) -> list[Record]:
        session = getattr(self.projects, "session", lambda: None)()
        if not session:
            return []
        limit = min(max((input or {}).get("limit", 200), 1), 1000)
        self._runtime.initialize()
        return self._runtime.load_wiring_changes(str(session["projectId"]), int(limit))

    def _coalesce(self, entry: Record) -> Record:
        """Fold rapid edits of one connection (pin by pin) into a single log entry."""
        last = self._last_changes.get(entry["connectionId"])
        if (
            last is None
            or last["kind"] == "removed"
            or entry["kind"] == "added"
            or parse_date_ms(entry["at"]) - parse_date_ms(last["at"]) > COALESCE_MS
        ):
            return entry
        if last["kind"] == "added":
            # Added then edited is still one addition; added then removed never happened.
            dropped = entry["kind"] == "removed"
            return {**entry, "entryId": last["entryId"], "kind": "added", "dropped": dropped}
        original = last["previous"]
        if entry["kind"] == "removed":
            return {**entry, **clone(original), "entryId": last["entryId"]}
        unchanged = all(original[key] == entry[key] for key in CONNECTION_KEYS)
        return {**entry, "entryId": last["entryId"], "previous": original, "dropped": unchanged}

    async def close(self) -> None:
        for task in self._tasks.values():
            self._persist(task)

    def snapshot(self) -> Record:
        connections = self.projects.wiring()["connections"]
        return {
            "connections": clone(connections),
            "wiringRevision": self.wiring_revision(connections),
        }

    @staticmethod
    def connection_signature(connection: Record) -> str:
        value = {
            "connectionId": connection.get("connectionId"),
            "portA": connection.get("portA"),
            "portB": connection.get("portB"),
            "pins": connection.get("pins", []),
        }
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    @classmethod
    def wiring_revision(cls, connections: list[Record]) -> str:
        encoded = json.dumps(
            sorted(
                (cls.connection_signature(connection) for connection in connections),
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def _apply_confirmed_wiring(self, task: Record) -> None:
        wiring = self.projects.wiring()
        index = next(
            (
                index
                for index, item in enumerate(wiring["connections"])
                if item["portA"] == task["portA"] and item["portB"] == task["portB"]
            ),
            -1,
        )
        if task["action"] == "connect":
            connection = {
                "connectionId": wiring["connections"][index]["connectionId"]
                if index >= 0
                else new_uuid(),
                "portA": task["portA"],
                "portB": task["portB"],
                "pins": task["pins"],
                "confirmedAt": utc_now_iso(),
                "confirmedBy": task.get("operatorName", "operator"),
            }
            if index >= 0:
                wiring["connections"][index] = connection
            else:
                wiring["connections"].append(connection)
        elif index >= 0:
            del wiring["connections"][index]
        self.projects.update_wiring(wiring)
        if self._project_notifier:
            self._project_notifier()

    def _finish(self, task: Record, status: str, message: str | None = None) -> Record:
        finished = {**task, "status": status, "completedAt": utc_now_iso()}
        if status == "confirmed":
            finished["wiringRevision"] = self.snapshot()["wiringRevision"]
        if message:
            finished["message"] = message
        self._tasks[task["wiringTaskId"]] = finished
        self._persist(finished)
        self._emit(finished)
        return clone(finished)

    def _apply_lazy_timeout(self, task: Record) -> None:
        if task["status"] != "pending" or parse_date_ms(task["expiresAt"]) > now_ms():
            return
        expired = {
            **task,
            "status": "timed_out",
            "completedAt": utc_now_iso(),
            "message": "Wiring task expired before processing started",
        }
        self._tasks[task["wiringTaskId"]] = expired
        self._persist(expired)
        task.update(expired)
        self._emit(expired)

    def _emit(self, task: Record) -> None:
        if self._notifier:
            self._notifier(clone(task))

    def _persist(self, task: Record) -> None:
        session = getattr(self.projects, "session", lambda: None)()
        if not session:
            return
        self._runtime.initialize()
        self._runtime.save_wiring_task(str(session["projectId"]), task)

    def _lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())


def canonical_ports(left: str, right: str, pins: list[Record]) -> tuple[str, str, list[Record]]:
    a, b = left.strip(), right.strip()
    if not a or not b:
        raise app_error("invalid_argument", "Two port references are required")
    if a == b:
        if not pins or any(pin["a"] == pin["b"] for pin in pins):
            raise app_error("invalid_argument", "Same-port wiring requires distinct pin pairs")
        pairs = [sorted((pin["a"], pin["b"])) for pin in pins]
        return a, b, [{"a": left, "b": right} for left, right in pairs]
    if a <= b:
        return a, b, [{"a": pin["a"], "b": pin["b"]} for pin in pins]
    return b, a, [{"a": pin["b"], "b": pin["a"]} for pin in pins]


def default_port_positions(port_ids: list[str]) -> Record:
    if not port_ids:
        return {}
    if len(port_ids) == 1:
        return {port_ids[0]: {"side": "right", "offset": 0.5}}
    if len(port_ids) == 2:
        return {
            port_ids[0]: {"side": "left", "offset": 0.5},
            port_ids[1]: {"side": "right", "offset": 0.5},
        }
    sides = ("top", "right", "bottom", "left")
    by_side: dict[str, list[str]] = {side: [] for side in sides}
    for index, port_id in enumerate(port_ids):
        by_side[sides[index % 4]].append(port_id)
    return {
        port_id: {"side": side, "offset": (index + 1) / (len(ids) + 1)}
        for side, ids in by_side.items()
        for index, port_id in enumerate(ids)
    }
