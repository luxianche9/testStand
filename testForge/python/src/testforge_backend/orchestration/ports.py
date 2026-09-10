from __future__ import annotations

from typing import Any, Protocol

Json = dict[str, Any]


class ProjectPort(Protocol):
    def task(self) -> Json: ...
    def wiring(self) -> Json: ...
    def update_task(self, task: Json) -> Json: ...
    def project_id(self) -> str: ...
    def session(self) -> Json | None: ...


class ToolPort(Protocol):
    def list_tools(self) -> list[Json]: ...
    def is_hardware_occupied(self, hardware_id: str) -> bool: ...
    async def call_tool(self, name: str, args: Json, options: Json | None = None) -> Any: ...


class CatalogPort(Protocol):
    def get_hardware(self, hardware_id: str) -> Json: ...


class ExecutionLease(Protocol):
    def release(self) -> None: ...


class ExecutionPort(Protocol):
    def acquire(self, activity: Json) -> ExecutionLease: ...


class RunLogPort(Protocol):
    async def load(self, root_path: str) -> Json: ...
    async def upsert_run(self, root_path: str, run: Json) -> None: ...
    async def upsert_node_run(self, root_path: str, node_run: Json) -> None: ...
    async def append_events(self, root_path: str, run_id: str, events: list[Json]) -> None: ...
    async def upsert_execution_snapshot(self, root_path: str, snapshot: Json) -> None: ...
    async def remove(self, root_path: str, run_id: str) -> None: ...
    async def clear(self, root_path: str, run_ids: list[str]) -> None: ...


class NoopLease:
    def release(self) -> None:
        pass


class NoopExecution:
    def acquire(self, activity: Json) -> NoopLease:
        return NoopLease()


class NoopRunLogs:
    async def load(self, root_path: str) -> Json:
        return {"archives": [], "snapshots": [], "warnings": []}

    async def upsert_run(self, root_path: str, run: Json) -> None:
        pass

    async def upsert_node_run(self, root_path: str, node_run: Json) -> None:
        pass

    async def append_events(self, root_path: str, run_id: str, events: list[Json]) -> None:
        pass

    async def upsert_execution_snapshot(self, root_path: str, snapshot: Json) -> None:
        pass

    async def remove(self, root_path: str, run_id: str) -> None:
        pass

    async def clear(self, root_path: str, run_ids: list[str]) -> None:
        pass
