from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any

from hardwareharness_backend.automation.service import AutomationService
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.contracts.validation import boolean, obj, parse_record
from hardwareharness_backend.devices import DeviceCatalogService, DeviceService
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.workspace.apps import AppsService
from hardwareharness_backend.workspace.environment import EnvironmentManager
from hardwareharness_backend.workspace.files import WorkspaceService

from .authorization import Authorizer, Json
from .execution import ExecutionCoordinator


class ApplicationsApplication:
    """The desktop/Agent facade. Business scripts see none of these lifecycle APIs."""

    def __init__(
        self,
        authorizer: Authorizer,
        projects: ProjectService,
        devices: DeviceService,
        catalog: DeviceCatalogService,
        execution: ExecutionCoordinator,
        notifier: Callable[[str, Any], None] | None = None,
    ) -> None:
        self.authorizer, self.projects, self.devices = authorizer, projects, devices
        self.catalog, self.execution, self.notifier = catalog, execution, notifier
        self.environment = EnvironmentManager(busy=self._busy)
        self.apps: AppsService | None = None
        self._closed = False
        self.runner = self._new_runner()

    def _new_runner(self) -> AutomationService:
        return AutomationService(
            self._root_optional,
            self._invoke,
            acquire=self._acquire,
            python_provider=self._python,
            notifier=self._notify,
        )

    def _root_optional(self) -> str | None:
        session = self.projects.session()
        return str(session["rootPath"]) if session else None

    def _root(self) -> str:
        root = self._root_optional()
        if root is None:
            raise app_error("requires_project", "Open a project before using applications")
        return root

    def _busy(self) -> bool:
        return bool(self.runner.active or (self.apps and self.apps.busy))

    async def _python(self) -> str:
        return await self.environment.python(self._root())

    def _notify(self, event: Json) -> None:
        if self.notifier:
            kind = event["type"]
            self.notifier(kind, event["run"] if kind == "run" else event["event"])

    def _hardware(self, hardware_id: str) -> Json:
        hardware = self.catalog.get_hardware(hardware_id)
        if hardware["kind"] != "managed" or not hardware.get("serverId"):
            raise app_error("invalid_argument", f"Hardware {hardware_id} is passive")
        if not any(
            server["serverId"] == hardware["serverId"] and server["enabled"]
            for server in self.devices.list_servers()
        ):
            raise app_error("unavailable", f"Hardware server is unavailable: {hardware_id}")
        self.devices.occupancy.require_lease(hardware_id)
        return hardware

    async def _acquire(self, hardware_ids: list[str], run: Json) -> Callable[[], None]:
        for hardware_id in hardware_ids:
            self._hardware(hardware_id)
        lease = self.execution.acquire(
            {
                "state": "run",
                "runId": run["runId"],
                "hardwareIds": hardware_ids,
                "startedAt": run["startedAt"],
            }
        )
        return lease.release

    async def _invoke(
        self, hardware_id: str, tool_name: str, arguments: Json, timeout_ms: int
    ) -> Any:
        hardware = self._hardware(hardware_id)
        tool = next(
            (item for item in self.devices.list_tools() if item["externalName"] == tool_name), None
        )
        if not tool or tool["kind"] == "internal":
            raise app_error("unavailable", f"Public hardware tool is unavailable: {tool_name}")
        if tool["serverId"] != hardware["serverId"]:
            raise app_error("invalid_argument", "Tool belongs to another hardware server")
        if tool["kind"] == "hardware":
            available = next(
                (
                    item
                    for item in self.devices.list_availability()
                    if item["hardwareId"] == hardware_id
                ),
                None,
            )
            if not available or available["state"] != "available":
                raise app_error("unavailable", f"Hardware {hardware_id} is not available")
        return await self.devices.call_tool(
            tool_name,
            arguments,
            {
                "timeoutMs": timeout_ms,
                "preserveEnvelope": True,
                "metadata": {"hardwareId": hardware_id},
            },
        )

    def _workspace(self) -> WorkspaceService:
        return WorkspaceService(self._root())

    def _apps(self) -> AppsService:
        if self.apps is None:
            self.apps = AppsService(self._root(), self.runner, self.environment)
        return self.apps

    def _authorize(self, context: Json, action: str = "read") -> None:
        self.authorizer.authorize(context, f"applications.{action}")
        if self._closed:
            raise app_error("unavailable", "Project workspace is switching or closed")

    def _write_guard(self, path: str) -> None:
        if path.casefold() in {"pyproject.toml", "uv.lock"} and self._busy():
            raise app_error("conflict", "Stop applications and runs before changing dependencies")

    def list_files(self, context: Json) -> list[Json]:
        self._authorize(context)
        return self._workspace().tree()

    def read_file(self, context: Json, path: str) -> Json:
        self._authorize(context)
        return self._workspace().read(path)

    def write_file(self, context: Json, input: Json) -> Json:
        self._authorize(context, "manage")
        self._write_guard(input["path"])
        return self._workspace().write(input["path"], input["content"], input["expectedHash"])

    def create_file(self, context: Json, input: Json) -> None:
        self._authorize(context, "manage")
        self._write_guard(input["path"])
        self._workspace().create(input["path"], input["kind"], input.get("content", ""))

    def rename_file(self, context: Json, input: Json) -> None:
        self._authorize(context, "manage")
        self._write_guard(input["path"])
        self._write_guard(input["target"])
        self._workspace().rename(input["path"], input["target"])

    def delete_file(self, context: Json, path: str) -> None:
        self._authorize(context, "manage")
        self._write_guard(path)
        self._workspace().delete(path)

    def search(self, context: Json, query: str) -> list[Json]:
        self._authorize(context)
        return self._workspace().search(query)

    async def diagnostics(self, context: Json, path: str, content: str | None = None) -> list[Json]:
        self._authorize(context)
        workspace = self._workspace()
        diagnostics = workspace.syntax_diagnostics(path, content)
        if diagnostics or not path.endswith(".py"):
            return diagnostics
        python = await self._python()
        self._authorize(context)
        return await workspace.diagnose(path, content, python=python)

    async def initialize_workspace(self, context: Json, options: Json | None = None) -> Json:
        self._authorize(context, "manage")
        parsed = parse_record(
            obj({"online": boolean().default(False)}, strict=True),
            {} if options is None else options,
        )
        return await self.environment.prepare(self._root(), online=parsed["online"])

    def list_apps(self, context: Json) -> list[Json]:
        self._authorize(context)
        return self._apps().list_apps()

    def create_app(self, context: Json, id: str, name: str) -> Json:
        self._authorize(context, "manage")
        self.environment.scaffold(self._root())
        return self._apps().create_app(id, name)

    async def start_app(self, context: Json, id: str) -> Json:
        self._authorize(context, "run")
        return await self._apps().start(id)

    async def stop_app(self, context: Json, id: str) -> Json:
        self._authorize(context, "run")
        return await self._apps().stop(id)

    def app_logs(self, context: Json, id: str, after: int = 0) -> list[Json]:
        self._authorize(context)
        return self._apps().logs(id, after)

    async def start_run(self, context: Json, input: Json) -> Json:
        self._authorize(context, "run")
        return await self.runner.start_run(input)

    async def cancel_run(self, context: Json, run_id: str) -> Json:
        self._authorize(context, "run")
        return await self.runner.cancel_run(run_id)

    async def get_run(self, context: Json, run_id: str) -> Json:
        self._authorize(context)
        return await self.runner.get_run(run_id)

    async def list_runs(self, context: Json, input: Json | None = None) -> list[Json]:
        self._authorize(context)
        return await self.runner.list_runs(input)

    async def run_events(
        self, context: Json, run_id: str, after: int = 0, limit: int = 500
    ) -> list[Json]:
        self._authorize(context)
        return await self.runner.run_events(run_id, after, limit)

    async def export_run(self, context: Json, run_id: str) -> Json:
        self._authorize(context)
        detail = await self.runner.get_run(run_id)
        events = []
        after = 0
        while batch := await self.runner.run_events(run_id, after, 1000):
            events.extend(batch)
            after = batch[-1]["sequence"]
        return {**detail, "events": events, "hasMore": False}

    async def delete_run(self, context: Json, run_id: str) -> Json:
        self._authorize(context, "logs.manage")
        await self.runner.delete_run(run_id)
        return {"runId": run_id}

    async def clear_completed_runs(self, context: Json) -> Json:
        self._authorize(context, "logs.manage")
        return await self.runner.clear_completed_runs()

    async def read_run_source(self, context: Json, run_id: str, path: str) -> Json:
        self._authorize(context)
        content = await self.runner.read_run_source(run_id, path)
        return {
            "path": path,
            "content": content,
            "hash": hashlib.sha256(content.encode()).hexdigest(),
        }

    async def read_run_attachment(self, context: Json, run_id: str, path: str) -> Json:
        self._authorize(context)
        return await self.runner.read_run_attachment(run_id, path)

    async def close(self) -> None:
        self._closed = True
        await self.environment.cancel_pending()
        if self.apps is not None:
            await self.apps.close()
            self.apps = None
        await self.runner.close()

    def resume(self) -> None:
        self.runner = self._new_runner()
        self._closed = False
