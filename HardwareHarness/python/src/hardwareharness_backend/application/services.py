from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, Protocol, TypeVar, cast

from hardwareharness_backend.compat import utc_now_iso
from hardwareharness_backend.contracts.devices import (
    parse_hardware,
    parse_mcp_server,
    parse_remote_computer,
)
from hardwareharness_backend.contracts.errors import app_error

from .applications import ApplicationsApplication
from .authorization import Authorizer, Json
from .execution import ExecutionCoordinator

if TYPE_CHECKING:
    from hardwareharness_backend.devices import DeviceCatalogService, DeviceService
    from hardwareharness_backend.projects import ProjectService
    from hardwareharness_backend.wiring import ProjectWiringService

T = TypeVar("T")

# Platform-owned policy, independent of third-party readOnlyHint annotations.
_BUILTIN_METADATA_READS = {
    server: {"get_server_info", "list_hardware", "get_hardware_info", "get_pinout"}
    for server in ("CP118U_I_MCP", "PCI1710L_MCP", "PCI6208V_MCP", "PCI1762_MCP")
}
_BUILTIN_METADATA_READS["FIREDAP_MCP"] = {
    "get_server_info",
    "list_hardware",
    "get_hardware_info",
    "get_pinout",
    "firedap_get_job",
    "firedap_wait_job",
    "firedap_get_board_reference",
}


class ApplicationSystemPort(Protocol):
    def gateway_status(self) -> Json: ...


class DevicesApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        service: DeviceService,
        catalog: DeviceCatalogService,
        execution: ExecutionCoordinator | None = None,
    ) -> None:
        self.authorizer, self.service, self.catalog = authorizer, service, catalog
        self.execution = execution or ExecutionCoordinator()
        self.active: dict[asyncio.Task[Any], str] = {}
        self._calls_closed = False

    def list_computers(self, context: Json) -> list[Json]:
        self.authorizer.authorize(context, "devices.read")
        return self.service.list_computers()

    async def save_computer(
        self, context: Json, input: Json, credentials: Json | None = None
    ) -> Json:
        self.authorizer.authorize(context, "devices.manageComputers")
        return await self.service.save_computer(parse_remote_computer(input), credentials)

    async def remove_computer(self, context: Json, computer_id: str) -> Json:
        self.authorizer.authorize(context, "devices.manageComputers")
        await self.service.remove_computer(computer_id)
        return {"computerId": computer_id}

    async def get_computer_status(self, context: Json, computer_id: str) -> Json:
        self.authorizer.authorize(context, "devices.read")
        computer = await self.service.refresh_computer(computer_id)
        servers = await asyncio.gather(
            *(
                self.service.refresh_server(server["serverId"])
                for server in self.service.list_servers()
                if server["computerId"] == computer_id
            )
        )
        return {**computer, "servers": servers}

    async def execute_ssh(
        self, context: Json, computer_id: str, command: str, timeout_ms: int | None = None
    ) -> Json:
        self.authorizer.authorize(context, "devices.ssh")
        if timeout_ms is None:
            return await self.service.execute(computer_id, command)
        return await self.service.execute(computer_id, command, timeout_ms)

    def list_servers(self, context: Json) -> list[Json]:
        self.authorizer.authorize(context, "devices.read")
        return self.service.list_servers()

    async def list_servers_with_status(self, context: Json) -> Json:
        self.authorizer.authorize(context, "devices.read")
        servers = self.service.list_servers()
        return {"servers": servers, "statuses": await self.service.refresh_all_servers()}

    async def save_server(
        self, context: Json, input: Json, credentials: Json | None = None
    ) -> Json:
        self.authorizer.authorize(context, "devices.manageServers")
        return await self.service.save_server(parse_mcp_server(input), credentials)

    async def remove_server(self, context: Json, server_id: str) -> Json:
        self.authorizer.authorize(context, "devices.manageServers")
        await self.service.remove_server(server_id)
        return {"serverId": server_id}

    async def refresh_server(self, context: Json, server_id: str) -> Json:
        self.authorizer.authorize(context, "devices.read")
        return await self.service.refresh_server(server_id)

    async def server_action(self, context: Json, server_id: str, action: str) -> Json:
        self.authorizer.authorize(
            context,
            "devices.forceStopServers" if action == "force-stop" else "devices.controlServers",
        )
        return await self.service.server_action(server_id, action)

    async def read_server_logs(
        self, context: Json, server_id: str, lines: int | None = None
    ) -> Json:
        self.authorizer.authorize(context, "devices.read")
        if lines is None:
            return await self.service.read_server_logs(server_id)
        return await self.service.read_server_logs(server_id, lines)

    async def list_managed_hardware(self, context: Json) -> list[Json]:
        self.authorizer.authorize(context, "hardware.read")
        return await self.service.refresh_hardware()

    def list_hardware(self, context: Json) -> list[Json]:
        self.authorizer.authorize(context, "hardware.read")
        return self.catalog.list_hardware()

    def get_hardware(self, context: Json, hardware_id: str) -> Json:
        self.authorizer.authorize(context, "hardware.read")
        return self.catalog.get_hardware(hardware_id)

    async def save_hardware(self, context: Json, input: Json) -> Json:
        self.authorizer.authorize(context, "hardware.manage")
        hardware = parse_hardware(input)
        assigned = next(
            (
                server
                for server in self.service.list_servers()
                if server["hardwareId"] == hardware["hardwareId"]
            ),
            None,
        )
        if hardware["kind"] == "managed" and not assigned:
            raise app_error(
                "invalid_argument",
                f"Hardware {hardware['hardwareId']} is not assigned to an MCP server; "
                "register_mcp_server first or save as kind passive",
            )
        if hardware["kind"] == "passive" and assigned:
            raise app_error(
                "invalid_argument",
                f"Hardware {hardware['hardwareId']} is assigned to MCP server "
                f"{assigned['serverId']}; unregister that server before treating it as passive",
            )
        return await self.catalog.save_hardware(hardware)

    async def remove_hardware(self, context: Json, hardware_id: str) -> Json:
        self.authorizer.authorize(context, "hardware.manage")
        await self.catalog.remove_hardware(hardware_id)
        return {"hardwareId": hardware_id}

    async def set_hardware_image_bytes(
        self,
        context: Json,
        hardware_id: str,
        port_id: str | None,
        data: bytes,
        extension_hint: str = "",
    ) -> Any:
        self.authorizer.authorize(context, "hardware.manage")
        return await self.service.store.put_image_bytes(hardware_id, port_id, data, extension_hint)

    async def set_hardware_image_from_path(
        self, context: Json, hardware_id: str, port_id: str | None, source_path: str
    ) -> Any:
        self.authorizer.authorize(context, "hardware.manage")
        return await self.service.store.put_image(hardware_id, port_id, source_path)

    async def remove_hardware_image(
        self, context: Json, hardware_id: str, port_id: str | None = None
    ) -> Any:
        self.authorizer.authorize(context, "hardware.manage")
        return await self.service.store.remove_image(hardware_id, port_id)

    async def export_bundle(self, context: Json, hardware_id: str) -> bytes:
        self.authorizer.authorize(context, "hardware.read")
        return cast(bytes, await self.service.store.export_bundle(hardware_id))

    async def import_bundle(self, context: Json, data: bytes) -> Json:
        self.authorizer.authorize(context, "hardware.manage")
        return cast(Json, await self.service.store.import_bundle(data))

    async def inspect_bundle(self, context: Json, data: bytes) -> Json:
        self.authorizer.authorize(context, "hardware.manage")
        return cast(Json, await self.service.store.inspect_bundle(data))

    async def import_bundle_for_server(
        self, context: Json, data: bytes, hardware_id: str, server_id: str
    ) -> Json:
        self.authorizer.authorize(context, "hardware.manage")
        server = next(
            (server for server in self.service.list_servers() if server["serverId"] == server_id),
            None,
        )
        if server is None:
            raise ValueError(f"MCP server not found: {server_id}")
        if server["hardwareId"] != hardware_id:
            raise ValueError(
                f"MCP server {server_id} is assigned to hardware {server['hardwareId']}, "
                f"not {hardware_id}"
            )
        return cast(
            Json,
            await self.service.store.import_bundle(
                data, {"expectedHardwareId": hardware_id, "allowManagedServerId": server_id}
            ),
        )

    async def call_tool(self, context: Json, name: str, args: Json) -> Any:
        self.authorizer.authorize(context, "hardware.executeTools")
        if self._calls_closed:
            raise app_error("unavailable", "Hardware execution is shutting down")
        tool = next(
            (item for item in self.service.list_tools() if item["externalName"] == name), None
        )
        if tool is None or tool["kind"] == "internal":
            raise app_error("unavailable", f"Unknown public hardware tool: {name}")
        server = next(
            (item for item in self.service.list_servers() if item["serverId"] == tool["serverId"]),
            None,
        )
        if server is None:
            raise app_error("unavailable", f"Unknown hardware server: {tool['serverId']}")
        metadata_read = tool.get("remoteName") in _BUILTIN_METADATA_READS.get(
            tool["serverId"], set()
        )
        handle = (
            None
            if metadata_read
            else self.execution.acquire(
                {
                    "state": "manual",
                    "hardwareId": server["hardwareId"],
                    "toolName": name,
                    "startedAt": utc_now_iso(),
                }
            )
        )
        task = asyncio.create_task(self.service.call_aggregated_tool(name, args))
        self.active[task] = server["hardwareId"]
        try:
            return await task
        except asyncio.CancelledError as error:
            raise app_error(
                "cancelled",
                "Hardware call cancelled; remote result may be unknown",
                {"outcomeKnown": False, "automaticRetry": False, "toolName": name},
            ) from error
        finally:
            self.active.pop(task, None)
            if handle is not None:
                handle.release()

    async def abort_hardware(self, hardware_id: str) -> None:
        tasks = [task for task, hardware in self.active.items() if hardware == hardware_id]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close_calls(self) -> None:
        self._calls_closed = True
        tasks = list(self.active)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def list_tools(self, context: Json) -> list[Json]:
        self.authorizer.authorize(context, "hardware.executeTools")
        return self.service.list_tools()


class ProjectsApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        projects: ProjectService,
        wiring: ProjectWiringService,
        applications: ApplicationsApplication,
    ) -> None:
        self._notifier: Callable[[Json | None, bool], None] | None = None
        self._transition = asyncio.Lock()
        self._closed = False
        self.authorizer, self.projects, self.wiring, self.applications = (
            authorizer,
            projects,
            wiring,
            applications,
        )

    def set_notifier(self, notifier: Callable[[Json | None, bool], None]) -> None:
        self._notifier = notifier

    def document(self, context: Json) -> Json | None:
        self.authorizer.authorize(context, "projects.read")
        return self.projects.current()

    async def inspect_folder(self, context: Json, root_path: str) -> Json:
        self.authorizer.authorize(context, "projects.read")
        return await self.projects.inspect_folder(root_path)

    async def initialize_folder(self, context: Json, root_path: str) -> Json:
        self.authorizer.authorize(context, "projects.manage")
        return await self._switch(lambda: self.projects.initialize_folder(root_path))

    async def open_folder(self, context: Json, root_path: str) -> Json:
        self.authorizer.authorize(context, "projects.manage")
        return await self._switch(lambda: self.projects.open_folder(root_path))

    async def save_project(self, context: Json) -> Json:
        self.authorizer.authorize(context, "projects.manage")
        document = await self.projects.save()
        if self._notifier:
            self._notifier(document, False)
        return document

    async def leave_project(self, context: Json) -> None:
        self.authorizer.authorize(context, "projects.manage")
        await self._switch(self.projects.leave)

    async def list_recent(self, context: Json) -> list[Json]:
        self.authorizer.authorize(context, "projects.read")
        return await self.projects.list_recent()

    async def forget_recent(self, context: Json, root_path: str) -> None:
        self.authorizer.authorize(context, "projects.manage")
        await self.projects.forget_recent(root_path)

    async def close(self) -> None:
        self._closed = True
        async with self._transition:
            await self.applications.close()
            await self.wiring.close()
            await self.projects.close()

    async def _switch(self, action: Callable[[], Awaitable[T]]) -> T:
        async with self._transition:
            if self._closed:
                raise app_error("unavailable", "Project service is shutting down")
            return await self._switch_locked(action)

    async def _switch_locked(self, action: Callable[[], Awaitable[T]]) -> T:
        await self.applications.close()
        await self.wiring.close()
        self.wiring.clear_session()
        try:
            result = await action()
            await self.wiring.initialize()
            if not self._closed:
                self.applications.resume()
            if self._notifier:
                self._notifier(self.projects.current(), True)
            return result
        except Exception:
            await self.wiring.initialize()
            if not self._closed:
                self.applications.resume()
            raise


class WiringApplication:
    def __init__(
        self, authorizer: Authorizer, projects: ProjectService, wiring: ProjectWiringService
    ) -> None:
        self.authorizer, self.projects, self.wiring = authorizer, projects, wiring

    async def update_document(self, context: Json, wiring: Json) -> Json:
        self.authorizer.authorize(context, "wiring.confirm")
        self.wiring.validate_document_connections(wiring)
        return await self.projects.update_wiring_with_layout(wiring)

    async def add_managed_hardware_to_canvas(self, context: Json, hardware_id: str) -> Json:
        self.authorizer.authorize(context, "projects.manage")
        return await self.wiring.add_managed_hardware_to_canvas(hardware_id)

    async def request_task(self, context: Json, input: Json) -> Json:
        self.authorizer.authorize(context, "wiring.request")
        request = {key: input[key] for key in ["portA", "portB", "action"]}
        request["pins"] = input.get("pins", [])
        if "timeoutMs" in input:
            request["timeoutMs"] = input["timeoutMs"]
        requested_by = input.get("requestedBy", "agent" if context["actor"] == "agent" else None)
        if requested_by is not None:
            request["requestedBy"] = requested_by
        return await self.wiring.request_task(request)

    async def start_task(
        self, context: Json, task_id: str, operator_name: str | None = None
    ) -> Json:
        self.authorizer.authorize(context, "wiring.confirm")
        if operator_name is None:
            return await self.wiring.start_task(task_id)
        return await self.wiring.start_task(task_id, operator_name)

    async def complete_task(
        self, context: Json, task_id: str, outcome: str, message: str | None = None
    ) -> Json:
        self.authorizer.authorize(context, "wiring.confirm")
        return await self.wiring.complete_task(task_id, outcome, message)

    async def cancel_task(self, context: Json, task_id: str, message: str | None = None) -> Json:
        self.authorizer.authorize(context, "wiring.request")
        return await self.wiring.cancel_task(task_id, message)

    def get_task(self, context: Json, task_id: str) -> Json:
        self.authorizer.authorize(context, "wiring.read")
        return self.wiring.get_task(task_id)

    def list_tasks(self, context: Json, input: Json | None = None) -> list[Json]:
        self.authorizer.authorize(context, "wiring.read")
        return self.wiring.list_tasks(input)


class SystemApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        devices: DeviceService,
        system: ApplicationSystemPort,
        execution: ExecutionCoordinator,
    ) -> None:
        self.authorizer, self.devices, self.system, self.execution = (
            authorizer,
            devices,
            system,
            execution,
        )

    def dashboard(self, context: Json) -> Json:
        self.authorizer.authorize(context, "system.read")
        return {
            "computers": self.devices.list_computers(),
            "statuses": self.devices.list_statuses(),
            "servers": self.devices.list_servers(),
            "serverStatuses": self.devices.list_server_statuses(),
            "hardware": self.devices.list_hardware(),
            "tools": self.devices.list_tools(),
            "gateway": self.system.gateway_status(),
            "execution": self.execution.current(),
            "availability": self.devices.list_availability(),
        }
