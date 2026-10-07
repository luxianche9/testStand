from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, TypeVar, cast

from teststand_backend.contracts.devices import parse_device_instance, parse_hardware
from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.operations import operation
from teststand_backend.contracts.wiring import parse_request_wiring_task_input
from teststand_backend.devices.plugin_store import PluginStore
from teststand_backend.util import utc_now_iso

from .authorization import Authorizer, Json
from .confirmations import ConfirmationBroker
from .execution import ExecutionCoordinator

if TYPE_CHECKING:
    from teststand_backend.devices import DeviceCatalogService, DeviceService
    from teststand_backend.projects import ProjectService
    from teststand_backend.wiring import ProjectWiringService

T = TypeVar("T")


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

    @operation(
        "devices.listDevices",
        capability="devices.read",
        risk="read",
        profiles=("adapter",),
        idempotency="natural",
    )
    def list_devices(self, context: Json) -> list[Json]:
        """Registered devices (plugin instances) without connection status."""
        return self.service.list_devices()

    @operation(
        "devices.listDevicesWithStatus",
        capability="devices.read",
        risk="read",
        profiles=("adapter",),
        idempotency="natural",
    )
    async def list_devices_with_status(self, context: Json) -> Json:
        instances = self.service.list_devices()
        return {"devices": instances, "statuses": await self.service.refresh_all_devices()}

    @operation(
        "devices.saveDevice",
        capability="devices.manageDevices",
        risk="write",
        profiles=("adapter",),
        idempotency="natural",
        confirm=True,
    )
    async def save_device(self, context: Json, input: Json) -> Json:
        """Create or update a device's settings; the operator confirms in testStand."""
        return await self.service.save_device(parse_device_instance(input))

    @operation(
        "devices.removeDevice",
        capability="devices.manageDevices",
        risk="destructive",
        profiles=("adapter",),
        idempotency="natural",
        confirm=True,
    )
    async def remove_device(self, context: Json, device_id: str) -> Json:
        """Remove a device; the last device of a package also takes the package away (at the
        next start, since its code may be loaded)."""
        await self.service.remove_device(device_id)
        return {"deviceId": device_id}

    @operation(
        "devices.refreshDevice",
        capability="devices.read",
        risk="read",
        profiles=("adapter",),
        idempotency="natural",
    )
    async def refresh_device(self, context: Json, device_id: str) -> Json:
        return await self.service.refresh_device(device_id)

    @operation(
        "devices.listManagedHardware",
        capability="hardware.read",
        risk="read",
        profiles=("adapter", "plan", "explore"),
        idempotency="natural",
    )
    async def list_managed_hardware(self, context: Json) -> list[Json]:
        return await self.service.refresh_hardware()

    @operation(
        "devices.inspectPackage",
        capability="devices.manageDevices",
        risk="read",
        idempotency="natural",
    )
    def inspect_package(self, context: Json, data: bytes) -> Json:
        """What adding a device from a ``.tsdev`` would install: manifest, files, SHA-256 and any
        problems. Writes nothing."""
        return self._packages().inspect(data)

    @operation("devices.addDevice", capability="devices.manageDevices", risk="write", confirm=True)
    async def add_device(self, context: Json, data: bytes, label: str = "") -> Json:
        """Add a device from its ``.tsdev`` package. The package is installed when needed, the
        device gets generated ids and is connected at once."""
        installed = await self._packages().install(data)
        manifest = self._packages().inspect(data)["manifest"]
        taken = {item["deviceId"] for item in self.service.list_devices()}
        base = re.sub(r"[^A-Z0-9_]", "_", manifest["type"].upper())
        device_id = next(
            candidate
            for candidate in (base, *(f"{base}_{index}" for index in range(2, 1000)))
            if candidate not in taken
        )
        instance = await self.service.save_device(
            parse_device_instance(
                {
                    "deviceId": device_id,
                    "label": label.strip() or manifest["model"],
                    "hardwareId": f"{device_id}_CARD",
                    "type": manifest["type"],
                    "settings": {},
                    "enabled": True,
                }
            )
        )
        self.service.store.changed()
        status = await self.service.refresh_device(device_id)
        return {
            "device": instance,
            "status": status,
            "restartRequired": installed["restartRequired"],
        }

    @operation(
        "devices.addDeviceFromFile",
        capability="devices.manageDevices",
        risk="write",
        profiles=("adapter", "plan", "explore"),
        confirm=True,
    )
    async def add_device_from_file(self, context: Json, path: str, label: str = "") -> Json:
        """Add a device from a ``.tsdev`` device package on this computer (absolute path). The
        package's driver code runs inside testStand, so the operator confirms first."""
        file = Path(path)
        if file.suffix.lower() != ".tsdev" or not file.is_absolute():
            raise app_error("invalid_argument", "path must be an absolute path to a .tsdev file")
        try:
            data = await asyncio.to_thread(file.read_bytes)
        except OSError as error:
            raise app_error("not_found", f"Cannot read {path}: {error}") from error
        return await self.add_device(context, data, label)

    def _packages(self) -> PluginStore:
        if self.service.packages is None:
            raise app_error("unavailable", "Device packages are not available in this host")
        return self.service.packages

    @operation(
        "devices.listHardware",
        capability="hardware.read",
        risk="read",
        profiles=("adapter", "plan", "explore"),
        idempotency="natural",
    )
    def list_hardware(self, context: Json) -> list[Json]:
        return self.catalog.list_hardware()

    @operation(
        "devices.getHardware",
        capability="hardware.read",
        risk="read",
        profiles=("adapter", "plan", "explore"),
        idempotency="natural",
    )
    def get_hardware(self, context: Json, hardware_id: str) -> Json:
        return self.catalog.get_hardware(hardware_id)

    @operation(
        "devices.getDefinition",
        capability="hardware.read",
        risk="read",
        profiles=("adapter", "plan", "explore"),
        idempotency="natural",
    )
    def get_definition(self, context: Json, hardware_id: str) -> Json | None:
        """The managed device's ``/device`` declaration as cached (read-only, §9.7)."""
        return self.service.get_definition(hardware_id)

    @operation(
        "devices.saveHardware",
        capability="hardware.manage",
        risk="write",
        profiles=("adapter", "plan"),
        idempotency="natural",
    )
    async def save_hardware(self, context: Json, input: Json) -> Json:
        hardware = parse_hardware(input)
        assigned = next(
            (
                instance
                for instance in self.service.list_devices()
                if instance["hardwareId"] == hardware["hardwareId"]
            ),
            None,
        )
        if hardware["kind"] == "managed" and not assigned:
            raise app_error(
                "invalid_argument",
                f"Hardware {hardware['hardwareId']} is not assigned to a device; "
                "save_device first or save as kind passive",
            )
        if hardware["kind"] == "passive" and assigned:
            raise app_error(
                "invalid_argument",
                f"Hardware {hardware['hardwareId']} is assigned to device "
                f"{assigned['deviceId']}; unregister that instance before treating it as passive",
            )
        return await self.catalog.save_hardware(hardware)

    @operation(
        "devices.removeHardware",
        capability="hardware.manage",
        risk="destructive",
        profiles=("adapter", "plan"),
        idempotency="natural",
        confirm=True,
    )
    async def remove_hardware(self, context: Json, hardware_id: str) -> Json:
        await self.catalog.remove_hardware(hardware_id)
        return {"hardwareId": hardware_id}

    @operation(
        "devices.exportBundle",
        capability="hardware.read",
        risk="read",
        idempotency="natural",
    )
    async def export_bundle(self, context: Json, hardware_id: str) -> bytes:
        return cast(bytes, await self.service.store.export_bundle(hardware_id))

    @operation("devices.importBundle", capability="hardware.manage", risk="write")
    async def import_bundle(self, context: Json, data: bytes) -> Json:
        return cast(Json, await self.service.store.import_bundle(data))

    @operation(
        "devices.inspectBundle",
        capability="hardware.manage",
        risk="read",
        idempotency="natural",
    )
    async def inspect_bundle(self, context: Json, data: bytes) -> Json:
        return cast(Json, await self.service.store.inspect_bundle(data))

    @operation(
        "devices.callTool",
        capability="hardware.executeTools",
        risk="actuate",
        profiles=("adapter", "explore"),
    )
    async def call_tool(self, context: Json, name: str, args: Json) -> Any:
        if self._calls_closed:
            raise app_error("unavailable", "Hardware execution is shutting down")
        tool = next(
            (item for item in self.service.list_tools() if item["externalName"] == name), None
        )
        if tool is None or tool["kind"] == "internal":
            raise app_error("unavailable", f"Unknown public hardware tool: {name}")
        instance = next(
            (item for item in self.service.list_devices() if item["deviceId"] == tool["deviceId"]),
            None,
        )
        if instance is None:
            raise app_error("unavailable", f"Unknown hardware instance: {tool['deviceId']}")
        # The SDK's own management tools (device/hardware info) are platform-owned metadata
        # reads, independent of the adapter's annotations; only they bypass an active call.
        metadata_read = tool["kind"] == "management"
        handle = (
            None
            if metadata_read
            else self.execution.acquire(
                {
                    "state": "manual",
                    "hardwareId": instance["hardwareId"],
                    "toolName": name,
                    "startedAt": utc_now_iso(),
                }
            )
        )
        task = asyncio.create_task(self.service.call_aggregated_tool(name, args))
        self.active[task] = instance["hardwareId"]
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

    @operation(
        "devices.listTools",
        capability="hardware.executeTools",
        risk="read",
        profiles=("adapter", "explore"),
        idempotency="natural",
    )
    def list_tools(self, context: Json) -> list[Json]:
        return self.service.list_tools()


class ProjectsApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        projects: ProjectService,
        wiring: ProjectWiringService,
        execution: ExecutionCoordinator | None = None,
    ) -> None:
        self._notifier: Callable[[Json | None, bool], None] | None = None
        self._transition = asyncio.Lock()
        self._closed = False
        self.authorizer, self.projects, self.wiring = (
            authorizer,
            projects,
            wiring,
        )
        self.execution = execution or ExecutionCoordinator()

    def set_notifier(self, notifier: Callable[[Json | None, bool], None]) -> None:
        self._notifier = notifier

    @operation(
        "projects.document",
        capability="projects.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def document(self, context: Json) -> Json | None:
        return self.projects.current()

    @operation(
        "projects.inspectFolder",
        capability="projects.read",
        risk="read",
        idempotency="natural",
    )
    async def inspect_folder(self, context: Json, root_path: str) -> Json:
        return await self.projects.inspect_folder(root_path)

    @operation(
        "projects.initializeFolder", capability="projects.manage", risk="write", profiles=("plan",)
    )
    async def initialize_folder(self, context: Json, root_path: str) -> Json:
        return await self._switch(lambda: self.projects.initialize_folder(root_path))

    @operation(
        "projects.openFolder", capability="projects.manage", risk="write", profiles=("plan",)
    )
    async def open_folder(self, context: Json, root_path: str) -> Json:
        return await self._switch(lambda: self.projects.open_folder(root_path))

    @operation(
        "projects.saveProject", capability="projects.manage", risk="write", profiles=("plan",)
    )
    async def save_project(self, context: Json) -> Json:
        document = await self.projects.save()
        if self._notifier:
            self._notifier(document, False)
        return document

    @operation("projects.leaveProject", capability="projects.manage", risk="write")
    async def leave_project(self, context: Json) -> None:
        await self._switch(self.projects.leave)

    @operation(
        "projects.listRecent",
        capability="projects.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    async def list_recent(self, context: Json) -> list[Json]:
        """Recently opened project folders, newest first; open one with open_project."""
        return await self.projects.list_recent()

    @operation(
        "projects.forgetRecent",
        capability="projects.manage",
        risk="write",
        idempotency="natural",
    )
    async def forget_recent(self, context: Json, root_path: str) -> None:
        await self.projects.forget_recent(root_path)

    async def close(self) -> None:
        self._closed = True
        async with self._transition:
            await self.wiring.close()
            await self.projects.close()

    async def _switch(self, action: Callable[[], Awaitable[T]]) -> T:
        async with self._transition:
            if self._closed:
                raise app_error("unavailable", "Project service is shutting down")
            if self.execution.current()["state"] != "idle":
                raise app_error("conflict", "Finish the active execution before switching projects")
            return await self._switch_locked(action)

    async def _switch_locked(self, action: Callable[[], Awaitable[T]]) -> T:
        await self.wiring.close()
        self.wiring.clear_session()
        try:
            result = await action()
            await self.wiring.initialize()
            if self._notifier:
                self._notifier(self.projects.current(), True)
            return result
        except Exception:
            await self.wiring.initialize()
            raise


class WiringApplication:
    def __init__(
        self, authorizer: Authorizer, projects: ProjectService, wiring: ProjectWiringService
    ) -> None:
        self.authorizer, self.projects, self.wiring = authorizer, projects, wiring

    @operation(
        "wiring.updateDocument",
        capability="wiring.confirm",
        risk="write",
        idempotency="natural",
    )
    async def update_document(self, context: Json, wiring: Json) -> Json:
        self.wiring.validate_document_connections(wiring)
        previous = self.projects.wiring()["connections"]
        document = self.projects.update_wiring(wiring)
        self.wiring.record_manual_changes(previous, document["file"]["wiring"]["connections"])
        self.wiring.notify_project_changed()
        return document

    @operation("wiring.requestTask", capability="wiring.request", risk="write")
    async def request_task(self, context: Json, input: Json) -> Json:
        """Create one wiring task holding every change; the operator confirms or rejects it once.
        Returns at once with the pending task."""
        return await self.wiring.request_task(self._request(context, input))

    @operation(
        "wiring.requestWiring",
        capability="wiring.request",
        risk="write",
        profiles=("plan",),
    )
    async def request_wiring(self, context: Json, input: Json) -> Json:
        """Ask the operator to make wiring changes on the bench and wait for the answer. The call
        returns only when the operator confirmed (the project wiring then holds the changes and is
        saved) or rejected the request (``message`` says why); cancelling the call cancels the
        task."""
        task = await self.wiring.request_task(self._request(context, input))
        try:
            return await self.wiring.wait_for_answer(task["wiringTaskId"])
        except asyncio.CancelledError:
            await asyncio.shield(
                self.wiring.cancel_task(task["wiringTaskId"], "The request was cancelled")
            )
            raise

    @staticmethod
    def _request(context: Json, input: Json) -> Json:
        request = parse_request_wiring_task_input(input)
        if "requestedBy" not in request and context["actor"] == "agent":
            request["requestedBy"] = "agent"
        return request

    @operation("wiring.completeTask", capability="wiring.confirm", risk="write")
    async def complete_task(
        self,
        context: Json,
        task_id: str,
        outcome: str,
        message: str | None = None,
        operator_name: str = "operator",
    ) -> Json:
        """The operator's answer to a wiring task: ``confirmed`` applies every change and saves
        the project; ``rejected`` carries the operator's reason in ``message``."""
        return await self.wiring.complete_task(task_id, outcome, message, operator_name)

    @operation("wiring.cancelTask", capability="wiring.request", risk="write")
    async def cancel_task(self, context: Json, task_id: str, message: str | None = None) -> Json:
        return await self.wiring.cancel_task(task_id, message)

    @operation("wiring.getTask", capability="wiring.read", risk="read", idempotency="natural")
    def get_task(self, context: Json, task_id: str) -> Json:
        return self.wiring.get_task(task_id)

    @operation(
        "wiring.listChanges",
        capability="wiring.read",
        risk="read",
        profiles=("plan",),
        idempotency="natural",
    )
    def list_changes(self, context: Json, input: Json | None = None) -> list[Json]:
        """The project's wiring change log: confirmed wiring tasks and manual edits."""
        return self.wiring.list_changes(input)

    @operation("wiring.listTasks", capability="wiring.read", risk="read", idempotency="natural")
    def list_tasks(self, context: Json, input: Json | None = None) -> list[Json]:
        return self.wiring.list_tasks(input)


class SystemApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        devices: DeviceService,
        system: ApplicationSystemPort,
        execution: ExecutionCoordinator,
        confirmations: ConfirmationBroker | None = None,
    ) -> None:
        self.authorizer, self.devices, self.system, self.execution = (
            authorizer,
            devices,
            system,
            execution,
        )
        self.confirmations = confirmations or ConfirmationBroker()

    @operation(
        "system.listConfirmations", capability="system.read", risk="read", idempotency="natural"
    )
    def list_confirmations(self, context: Json) -> list[Json]:
        """The Agent's high-risk operations waiting for the operator (design doc 8.4)."""
        return self.confirmations.pending()

    @operation("system.answerConfirmation", capability="agents.manage", risk="write")
    def answer_confirmation(self, context: Json, confirmation_id: str, approve: bool) -> Json:
        """Approve or decline a pending confirmation; only a human holds ``agents.manage``."""
        return self.confirmations.answer(confirmation_id, approve)

    @operation("system.dashboard", capability="system.read", risk="read", idempotency="natural")
    def dashboard(self, context: Json) -> Json:
        return {
            "devices": self.devices.list_devices(),
            "deviceStatuses": self.devices.list_device_statuses(),
            "hardware": self.devices.list_hardware(),
            "tools": self.devices.list_tools(),
            "gateway": self.system.gateway_status(),
            "execution": self.execution.current(),
            "availability": self.devices.list_availability(),
        }
