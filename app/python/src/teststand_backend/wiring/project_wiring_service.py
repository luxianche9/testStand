import asyncio
import hashlib
import json
from collections.abc import Callable
from typing import Protocol

from teststand_backend.contracts.errors import app_error
from teststand_backend.testing.runtime_state import RuntimeStateStore
from teststand_backend.util import (
    Record,
    clone,
    new_uuid,
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
    async def save(self) -> Record: ...


class WiringHardwareCatalogPort(Protocol):
    def get_hardware(self, hardware_id: str) -> Record: ...
    def resolve_port(self, port_ref: str) -> Record: ...
    def validate_pins(self, port_a: str, port_b: str, pins: list[Record]) -> None: ...


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
        self._answered: dict[str, asyncio.Event] = {}

    def set_notifier(self, notifier: Callable[[Record], None]) -> None:
        self._notifier = notifier

    def set_project_notifier(self, notifier: Callable[[], None]) -> None:
        self._project_notifier = notifier

    def notify_project_changed(self) -> None:
        if self._project_notifier:
            self._project_notifier()

    async def initialize(self) -> None:
        session = getattr(self.projects, "session", lambda: None)()
        if not session:
            return
        await asyncio.to_thread(self._runtime.initialize)
        tasks = await asyncio.to_thread(self._runtime.load_wiring_tasks, str(session["projectId"]))
        self._tasks = {}
        for stored in tasks:
            task = _current_shape(stored)
            if task["status"] == "pending":
                # Nobody waits for a task of an earlier session: its request ended with it.
                task = {
                    **task,
                    "status": "cancelled",
                    "completedAt": utc_now_iso(),
                    "message": "testStand restarted before the operator answered",
                }
            if task != stored:
                await asyncio.to_thread(
                    self._runtime.save_wiring_task, str(session["projectId"]), task
                )
            self._tasks[str(task["wiringTaskId"])] = task

    def clear_session(self) -> None:
        for event in self._answered.values():
            event.set()
        self._tasks.clear()
        self._answered.clear()
        self._last_changes.clear()

    async def request_task(self, input: Record) -> Record:
        """One wiring task holding every change of ``input``: the operator answers it once.

        ``input`` is ``{changes: [{action, portA, portB, pins}], replaceAll?, note?,
        requestedBy?}``, or a single change's fields. ``replaceAll`` also disconnects every saved
        connection whose port pair is not connected by ``changes``."""
        raw = input.get("changes", [input])
        changes = [self._change(item) for item in raw]
        if input.get("replaceAll"):
            kept = {(item["portA"], item["portB"]) for item in changes}
            changes += [
                {
                    "action": "disconnect",
                    "portA": item["portA"],
                    "portB": item["portB"],
                    "pins": clone(item.get("pins", [])),
                }
                for item in self.projects.wiring()["connections"]
                if (item["portA"], item["portB"]) not in kept
            ]
        if not changes:
            raise app_error("invalid_argument", "A wiring task needs at least one change")
        pairs = [(item["portA"], item["portB"]) for item in changes]
        if len(set(pairs)) != len(pairs):
            raise app_error("invalid_argument", "Each port pair may appear once in one request")
        for existing in self._tasks.values():
            if existing["status"] != "pending":
                continue
            overlap = {(item["portA"], item["portB"]) for item in existing["changes"]} & set(pairs)
            if overlap:
                raise app_error(
                    "conflict",
                    "A pending wiring task already changes this port pair",
                    {
                        "existingTaskId": existing["wiringTaskId"],
                        "ports": sorted(f"{a} <-> {b}" for a, b in overlap),
                        "recovery": "Wait for the operator's answer to the pending task.",
                    },
                )
        hardware_ids = sorted(
            {
                self.catalog.resolve_port(port)["hardware"]["hardwareId"]
                for pair in pairs
                for port in pair
            }
        )
        task: Record = {
            "wiringTaskId": new_uuid(),
            "changes": changes,
            "hardwareIds": hardware_ids,
            "status": "pending",
            "requestedAt": utc_now_iso(),
        }
        if input.get("note"):
            task["note"] = input["note"]
        if input.get("requestedBy"):
            task["requestedBy"] = input["requestedBy"]
        self._tasks[task["wiringTaskId"]] = task
        self._answered[task["wiringTaskId"]] = asyncio.Event()
        self._persist(task)
        self._emit(task)
        return clone(task)

    def _change(self, item: Record) -> Record:
        references = [str(item.get(key, "")).strip() for key in ("portA", "portB")]
        if not all(references):
            raise app_error("invalid_argument", "Two port references are required")
        canonical = [
            f"{found['hardware']['hardwareId']}.{found['port']['portId']}"
            for found in (self.catalog.resolve_port(reference) for reference in references)
        ]
        port_a, port_b, pins = canonical_ports(canonical[0], canonical[1], item.get("pins", []))
        self.catalog.validate_pins(port_a, port_b, pins)
        return {"action": item["action"], "portA": port_a, "portB": port_b, "pins": pins}

    async def wait_for_answer(self, wiring_task_id: str) -> Record:
        """The task once the operator answered it (or it was cancelled)."""
        task = self.get_task(wiring_task_id)
        event = self._answered.get(wiring_task_id)
        if task["status"] == "pending" and event is not None:
            await event.wait()
        return self.get_task(wiring_task_id)

    def validate_document_connections(self, wiring: Record) -> None:
        """Validate edited same-port pins; untouched connections of unresolved hardware pass."""
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

    async def complete_task(
        self,
        wiring_task_id: str,
        outcome: str,
        message: str | None = None,
        operator_name: str = "operator",
    ) -> Record:
        async with self._lock(wiring_task_id):
            task = self.get_task(wiring_task_id)
            if task["status"] != "pending":
                raise app_error("conflict", f"Wiring task is {task['status']}, not pending")
            task = {**task, "operatorName": operator_name.strip() or "operator"}
            if outcome == "confirmed":
                try:
                    await self._apply_confirmed_wiring(task)
                except Exception as error:
                    return self._finish(task, "failed", f"Failed to update wiring: {error}")
            return self._finish(task, outcome, message)

    async def cancel_task(self, wiring_task_id: str, message: str | None = None) -> Record:
        async with self._lock(wiring_task_id):
            task = self.get_task(wiring_task_id)
            if task["status"] != "pending":
                return clone(task)
            return self._finish(task, "cancelled", message)

    def get_task(self, wiring_task_id: str) -> Record:
        task = self._tasks.get(wiring_task_id)
        if task is None:
            raise app_error(
                "not_found",
                f"Unknown wiringTaskId: {wiring_task_id}",
                {"recovery": "Tasks are session-scoped. Read get_project for saved connections."},
            )
        return clone(task)

    def list_tasks(self, input: Record | None = None) -> list[Record]:
        query = input or {}
        limit = min(max(query.get("limit", 100), 1), 500)
        items = [
            task
            for task in self._tasks.values()
            if "status" not in query or task["status"] == query["status"]
        ]
        items.sort(key=lambda task: task["requestedAt"], reverse=True)
        return [clone(task) for task in items[: int(limit)]]

    def record_manual_changes(
        self, previous: list[Record], current: list[Record], wiring_task_id: str | None = None
    ) -> list[Record]:
        """Log edits of the pin list: the operator's, or a confirmed wiring task's
        (``wiring_task_id``); a no-op edit leaves no entry."""
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
            if wiring_task_id is not None:
                entry["wiringTaskId"] = wiring_task_id
            if kind == "changed" and old is not None:
                entry["previous"] = {
                    "portA": old["portA"],
                    "portB": old["portB"],
                    "pins": clone(old.get("pins", [])),
                }
            entries.append(entry if wiring_task_id else self._coalesce(entry))
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
            or "wiringTaskId" in last
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

    async def _apply_confirmed_wiring(self, task: Record) -> None:
        """Apply every change of a confirmed task, log it and save the project: the wiring now
        is what the operator confirmed on the bench."""
        wiring = self.projects.wiring()
        previous = clone(wiring["connections"])
        connections = wiring["connections"]
        now = utc_now_iso()
        for change in task["changes"]:
            index = next(
                (
                    index
                    for index, item in enumerate(connections)
                    if item["portA"] == change["portA"] and item["portB"] == change["portB"]
                ),
                -1,
            )
            if change["action"] == "connect":
                connection = {
                    "connectionId": connections[index]["connectionId"]
                    if index >= 0
                    else new_uuid(),
                    "portA": change["portA"],
                    "portB": change["portB"],
                    "pins": clone(change["pins"]),
                    "confirmedAt": now,
                    "confirmedBy": task.get("operatorName", "operator"),
                }
                if index >= 0:
                    connections[index] = connection
                else:
                    connections.append(connection)
            elif index >= 0:
                del connections[index]
        self.projects.update_wiring(wiring)
        self.record_manual_changes(
            previous, self.projects.wiring()["connections"], task["wiringTaskId"]
        )
        await self.projects.save()
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
        event = self._answered.pop(task["wiringTaskId"], None)
        if event is not None:
            event.set()
        return clone(finished)

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


def _current_shape(task: Record) -> Record:
    """A stored task in the batch shape: tasks of earlier versions held one change and could be
    in progress or timed out."""
    result = clone(task)
    if "changes" not in result:
        result["changes"] = [
            {key: result.pop(key) for key in ("action", "portA", "portB", "pins") if key in result}
        ]
    result.pop("expiresAt", None)
    result.pop("startedAt", None)
    if result["status"] in ("in_progress", "timed_out"):
        result["status"] = "cancelled" if result["status"] == "timed_out" else "pending"
    return result
