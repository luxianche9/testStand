"""Composition root replacing the old in-process desktop services."""

from __future__ import annotations

import asyncio
import inspect
import re
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from hardwareharness_backend.application import (
    ApplicationsApplication,
    DefaultAuthorizer,
    ExecutionCoordinator,
    HardwareHarnessApplication,
)
from hardwareharness_backend.compat import UNDEFINED, clone, js_trim
from hardwareharness_backend.compat.collation import set_default_locale
from hardwareharness_backend.contracts.errors import AppError, to_wire_error
from hardwareharness_backend.devices import (
    DeviceCatalogService,
    DeviceService,
    DeviceStore,
    DeviceTransportRegistry,
    McpHttpTransport,
)
from hardwareharness_backend.host.migrations import migrate_global_storage
from hardwareharness_backend.host.rpc import DesktopSecretProtector, StdioRpc
from hardwareharness_backend.mcp_gateway import LocalMcpGateway
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.storage import SecretStore, SettingsStore
from hardwareharness_backend.wiring import ProjectWiringService

LLM_SECRET = "opencode.llm.api-key"
HUMAN = {"actor": "human", "source": "desktop"}
AGENT = {"actor": "agent", "source": "mcp"}

APPLICATION_METHODS = {
    "system": {"dashboard"},
    "devices": set(
        [
            "listComputers",
            "saveComputer",
            "removeComputer",
            "getComputerStatus",
            "executeSsh",
            "listServers",
            "listServersWithStatus",
            "saveServer",
            "removeServer",
            "refreshServer",
            "serverAction",
            "readServerLogs",
            "listManagedHardware",
            "listHardware",
            "getHardware",
            "saveHardware",
            "removeHardware",
            "setHardwareImageBytes",
            "setHardwareImageFromPath",
            "removeHardwareImage",
            "exportBundle",
            "importBundle",
            "inspectBundle",
            "importBundleForServer",
            "callTool",
            "listTools",
        ]
    ),
    "projects": set(
        [
            "document",
            "inspectFolder",
            "initializeFolder",
            "openFolder",
            "saveProject",
            "leaveProject",
            "listRecent",
            "forgetRecent",
        ]
    ),
    "wiring": set(
        [
            "addManagedHardwareToCanvas",
            "updateDocument",
            "requestTask",
            "startTask",
            "completeTask",
            "cancelTask",
            "getTask",
            "listTasks",
        ]
    ),
    "applications": {
        "clearCompletedRuns",
        "renameFile",
        "search",
        "deleteRun",
        "startRun",
        "createFile",
        "initializeWorkspace",
        "cancelRun",
        "listFiles",
        "writeFile",
        "exportRun",
        "getRun",
        "deleteFile",
        "listRuns",
        "diagnostics",
        "runEvents",
        "readRunSource",
        "readRunAttachment",
        "readFile",
    },
    "manual": {"invokeTool"},
}


@dataclass
class Services:
    settings: SettingsStore
    secrets: SecretStore
    transports: DeviceTransportRegistry
    store: DeviceStore
    devices: DeviceService
    projects: ProjectService
    wiring: ProjectWiringService
    applications: ApplicationsApplication
    application: HardwareHarnessApplication
    gateway: LocalMcpGateway


class HostRuntime:
    def __init__(self, rpc: StdioRpc) -> None:
        self.rpc = rpc
        self.services: Services | None = None
        self.generation = 0
        self._shutdown: asyncio.Task[None] | None = None
        self._background: set[asyncio.Task[Any]] = set()

    def require_services(self) -> Services:
        if self.services is None:
            raise AppError("unavailable", "Python backend is not ready")
        return self.services

    async def initialize(self, options: dict[str, Any]) -> dict[str, Any]:
        if self.services is not None:
            raise AppError("conflict", "Python backend is already initialized")
        root = Path(options["userData"])
        root.mkdir(parents=True, exist_ok=True)
        set_default_locale(options.get("locale", "zh-CN"))
        protector = DesktopSecretProtector(self.rpc)
        await migrate_global_storage(root, protector)
        settings = SettingsStore(root / "settings.json")
        await settings.initialize()
        secrets = SecretStore(root / "secrets.json", protector)
        await secrets.initialize()
        transports = DeviceTransportRegistry([McpHttpTransport(secrets)])
        store = DeviceStore(root / "devices")
        await store.initialize()
        devices = DeviceService(store, secrets, transports)
        projects = ProjectService(settings)
        await projects.initialize()
        catalog = DeviceCatalogService(store)
        wiring = ProjectWiringService(projects, catalog)
        await wiring.initialize()
        execution = ExecutionCoordinator()
        applications = ApplicationsApplication(
            DefaultAuthorizer(),
            projects,
            devices,
            catalog,
            execution,
            self.publish,
        )
        gateway: LocalMcpGateway
        application = HardwareHarnessApplication(
            {
                "devices": devices,
                "catalog": catalog,
                "projects": projects,
                "wiring": wiring,
                "applications": applications,
                "execution": execution,
                "system": SimpleNamespace(gateway_status=lambda: gateway.status()),
            }
        )
        gateway = LocalMcpGateway(application, secrets, options.get("gatewayPort", 8000))
        application.projects.set_notifier(self.publish_project)
        wiring.set_notifier(lambda task: self.publish("wiringTask", task))
        wiring.set_project_notifier(lambda: self.publish("project", projects.current()))
        execution.set_notifier(lambda activity: self.publish("execution", activity))
        test_token = options.get("gatewayTestToken")
        if (
            options.get("integrationTestMode")
            and isinstance(test_token, str)
            and test_token.strip()
        ):
            await gateway.replace_token(test_token.strip())
        await gateway.start()
        self.services = Services(
            settings,
            secrets,
            transports,
            store,
            devices,
            projects,
            wiring,
            applications,
            application,
            gateway,
        )
        gateway.set_change_notifier(self.publish_state)
        return {"protocolVersion": 1}

    def snapshot(self) -> dict[str, Any] | None:
        if self.services is None:
            return None
        services = self.services
        self.generation += 1
        result = {
            "generation": self.generation,
            "settings": services.settings.get(),
            "gateway": services.gateway.status(),
            "gatewayToken": services.gateway.token(),
            "llmApiKeyConfigured": services.secrets.has(LLM_SECRET),
        }
        project = services.projects.current()
        if project is not None:
            result["project"] = clone(project)
        if services.secrets.has(LLM_SECRET):
            try:
                key = services.secrets.get(LLM_SECRET).get("apiKey", UNDEFINED)
                if key is not UNDEFINED:
                    result["llmApiKey"] = key
            except Exception as error:
                result["llmApiKeyError"] = to_wire_error(error)
        return result

    def publish_state(self) -> None:
        if self.services is not None:
            self.rpc.notify("desktop.state", self.snapshot())

    def publish_project(self, document: dict[str, Any] | None, workspace_changed: bool) -> None:
        self.rpc.notify(
            "desktop.event",
            {
                "event": "project",
                "payload": document,
                "state": self.snapshot(),
                "workspaceChanged": workspace_changed,
            },
        )

    def publish(self, event: str, payload: Any) -> None:
        self.rpc.notify(
            "desktop.event", {"event": event, "payload": payload, "state": self.snapshot()}
        )

    async def dispatch(self, method: str, params: Any) -> Any:
        if method == "backend.initialize":
            return await self.initialize(params)
        if method == "backend.shutdown":
            await self.close()
            return UNDEFINED
        services = self.require_services()
        if self._shutdown is not None:
            raise AppError("unavailable", "Python backend is shutting down")
        if method.startswith("application."):
            parts = method.split(".")
            if len(parts) != 3 or parts[2] not in APPLICATION_METHODS.get(parts[1], set()):
                raise AppError("invalid_argument", f"Unknown backend method: {method}")
            args = list(params.get("args", []))
            if not args or args[0] != HUMAN:
                raise AppError("permission_denied", "Desktop request context must be human/desktop")
            while args and args[-1] is UNDEFINED:
                args.pop()
            operation = getattr(getattr(services.application, parts[1]), _snake(parts[2]))
            parameters = list(inspect.signature(operation).parameters.values())
            for index, value in enumerate(args):
                if value is UNDEFINED:
                    default = parameters[index].default
                    args[index] = None if default is inspect.Parameter.empty else default
            result = operation(*args)
            return await result if inspect.isawaitable(result) else result
        if method == "settings.update":
            return await services.settings.update(params)
        if method == "settings.saveLlm":
            await services.settings.update(
                {"llm": {"baseUrl": params["baseUrl"], "model": params["model"]}}
            )
            raw_key = params.get("apiKey")
            api_key = js_trim(raw_key) if isinstance(raw_key, str) else ""
            if params.get("clearApiKey"):
                await services.secrets.remove(LLM_SECRET)
            elif api_key:
                await services.secrets.set(LLM_SECRET, {"apiKey": api_key})
            return {
                **services.settings.get()["llm"],
                "apiKeyConfigured": services.secrets.has(LLM_SECRET),
            }
        if method == "gateway.rotateToken":
            return await services.gateway.rotate_token()
        if method == "gateway.replaceToken":
            await services.gateway.replace_token(params["token"])
            return UNDEFINED
        if method == "assets.resolveImagePath":
            return str(services.store.image_path(params["hardwareId"], params["assetId"]))
        if method == "backend.probeAvailability":
            results = await asyncio.gather(
                *(
                    services.application.devices.refresh_server(AGENT, server["serverId"])
                    for server in services.devices.list_servers()
                ),
                return_exceptions=True,
            )
            return {
                "availability": services.devices.list_availability(),
                "servers": [result for result in results if not isinstance(result, BaseException)],
            }
        if method == "agents.listTools":
            builtins = [
                {
                    "name": tool["name"],
                    "kind": "builtin",
                    "inputSchema": tool["inputSchema"],
                    **({"description": tool["description"]} if tool.get("description") else {}),
                }
                for tool in services.gateway.list_builtin_tools()
            ]
            remote = [
                {
                    "name": tool["externalName"],
                    "kind": "remote",
                    "inputSchema": tool["inputSchema"],
                    "serverId": tool["serverId"],
                    "remoteName": tool["remoteName"],
                    **({"description": tool["description"]} if tool.get("description") else {}),
                }
                for tool in services.application.devices.list_tools(AGENT)
            ]
            return [*builtins, *remote]
        raise AppError("invalid_argument", f"Unknown backend method: {method}")

    async def close(self) -> None:
        if self._shutdown is None:
            self._shutdown = asyncio.create_task(self._close())
        await self._shutdown

    async def _close(self) -> None:
        if self.services is None:
            return
        services = self.services
        await services.gateway.stop()
        await services.application.devices.close_calls()
        await services.application.manual.close()
        await services.application.projects.close()
        await services.devices.close()
        await services.transports.close()
        await services.secrets.flush()


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()
