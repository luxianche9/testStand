import asyncio
import math
from collections.abc import Callable
from functools import cmp_to_key
from typing import Protocol

from testforge_backend.compat import (
    Record,
    clone,
    iso_from_ms,
    js_trim,
    new_uuid,
    now_ms,
    parse_date_ms,
    utc_now_iso,
    utf16_compare,
)
from testforge_backend.contracts.errors import app_error


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

    def set_notifier(self, notifier: Callable[[Record], None]) -> None:
        self._notifier = notifier

    def set_project_notifier(self, notifier: Callable[[], None]) -> None:
        self._project_notifier = notifier

    async def initialize(self) -> None:
        """Session-scoped todos do not recover across restarts."""

    def clear_session(self) -> None:
        self._tasks.clear()

    async def add_managed_hardware_to_canvas(self, hardware_id: str) -> Record:
        async with self._lock("canvas:nodes"):
            identifier = js_trim(hardware_id)
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
        port_a, port_b, pins = canonical_ports(
            input["portA"], input["portB"], input.get("pins", [])
        )
        self.catalog.validate_pins(port_a, port_b, pins)
        hardware_ids = sorted(
            {
                self.catalog.resolve_port(port_a)["hardware"]["hardwareId"],
                self.catalog.resolve_port(port_b)["hardware"]["hardwareId"],
            },
            key=cmp_to_key(utf16_compare),
        )
        timeout_ms = min(max(input.get("timeoutMs", 1_800_000), 1000), 86_400_000)
        now = now_ms()
        for existing in self._tasks.values():
            if existing["status"] not in ("pending", "in_progress"):
                continue
            if existing["portA"] == port_a and existing["portB"] == port_b:
                raise app_error(
                    "conflict", "A pending wiring task already exists for this port pair"
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
        self._emit(task)
        return clone(task)

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
                "operatorName": js_trim(operator_name) or "operator",
            }
            self._tasks[wiring_task_id] = started
            self._emit(started)
            return clone(started)

    async def complete_task(
        self, wiring_task_id: str, outcome: str, message: str | None = None
    ) -> Record:
        async with self._lock(wiring_task_id):
            task = self.get_task(wiring_task_id)
            if task["status"] != "in_progress":
                raise app_error("conflict", "Wiring task is not in progress")
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
            raise RuntimeError(f"Unknown wiringTaskId: {wiring_task_id}")
        self._apply_lazy_timeout(task)
        return clone(task)

    def list_tasks(self, input: Record | None = None) -> list[Record]:
        from testforge_backend.compat.collation import locale_compare

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
        items.sort(
            key=cmp_to_key(
                lambda left, right: locale_compare(right["requestedAt"], left["requestedAt"])
            )
        )
        return [clone(task) for task in items[: int(limit)]]

    async def close(self) -> None:
        tasks = self.list_tasks({"status": "in_progress", "limit": 500})
        await asyncio.gather(
            *(self.cancel_task(task["wiringTaskId"], "Application shutdown") for task in tasks),
            return_exceptions=True,
        )

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
        if message:
            finished["message"] = message
        self._tasks[task["wiringTaskId"]] = finished
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
        task.update(expired)
        self._emit(expired)

    def _emit(self, task: Record) -> None:
        if self._notifier:
            self._notifier(clone(task))

    def _lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())


def canonical_ports(left: str, right: str, pins: list[Record]) -> tuple[str, str, list[Record]]:
    a, b = js_trim(left), js_trim(right)
    if not a or not b or a == b:
        raise RuntimeError("Two different port references are required")
    if utf16_compare(a, b) <= 0:
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
