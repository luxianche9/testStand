"""Composition root replacing the old in-process desktop services."""

from __future__ import annotations

import asyncio
import inspect
import re
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from testforge_backend.application import ExecutionCoordinator, TestForgeApplication
from testforge_backend.compat import UNDEFINED, clone, js_trim
from testforge_backend.compat.collation import set_default_locale
from testforge_backend.contracts.errors import AppError, to_wire_error
from testforge_backend.devices import (
    DeviceCatalogService,
    DeviceService,
    DeviceStore,
    DeviceTransportRegistry,
    McpHttpTransport,
)
from testforge_backend.host.migrations import migrate_global_storage
from testforge_backend.host.rpc import DesktopSecretProtector, StdioRpc
from testforge_backend.mcp_gateway import LocalMcpGateway
from testforge_backend.orchestration import TaskOrchestrationService
from testforge_backend.projects import ProjectService
from testforge_backend.storage import ProjectRunLogStore, SecretStore, SettingsStore
from testforge_backend.wiring import ProjectWiringService

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
    "orchestration": set(
        [
            "getTask",
            "updateTask",
            "validateTask",
            "startRun",
            "cancelRun",
            "getRun",
            "listRuns",
            "exportRun",
            "deleteRun",
            "clearCompletedRuns",
            "listOperatorDecisions",
            "respondOperatorDecision",
        ]
    ),
    "manual": {"invokeTool"},
    "occupancy": set(
        [
            "list",
            "refresh",
            "acquire",
            "release",
            "request",
            "getRequest",
            "listRequests",
            "acquireRequest",
            "rejectRequest",
            "cancelRequest",
        ]
    ),
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
    orchestration: TaskOrchestrationService
    application: TestForgeApplication
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
        orchestration = TaskOrchestrationService(
            projects,
            devices,
            catalog,
            execution,
            ProjectRunLogStore(),
            options.get("safety", {"cleanupBudgetMs": 15000, "cleanupOperatorTimeoutMs": 3000}),
        )
        await orchestration.initialize()
        gateway: LocalMcpGateway
        application = TestForgeApplication(
            {
                "devices": devices,
                "catalog": catalog,
                "projects": projects,
                "wiring": wiring,
                "orchestration": orchestration,
                "execution": execution,
                "system": SimpleNamespace(gateway_status=lambda: gateway.status()),
            }
        )
        gateway = LocalMcpGateway(application, secrets, options.get("gatewayPort", 8000))
        wiring.set_notifier(lambda task: self.publish("wiringTask", task))
        wiring.set_project_notifier(lambda: self.publish("project", projects.current()))
        orchestration.set_notifier(self.publish)
        execution.set_notifier(lambda activity: self.publish("execution", activity))
        application.occupancy.set_notifier(
            lambda request: self.publish("occupancyRequest", request)
        )

        def occupancy(statuses: list[dict[str, Any]]) -> None:
            application.occupancy.reconcile(statuses)
            self.publish("occupancy", statuses)

        def lost(hardware_id: str, message: str) -> None:
            async def abort() -> None:
                await asyncio.gather(
                    application.manual.abort_hardware(hardware_id, message),
                    orchestration.handle_hardware_lease_lost(hardware_id, message),
                    return_exceptions=True,
                )

            task = asyncio.create_task(abort())
            self._background.add(task)
            task.add_done_callback(self._background.discard)

        devices.occupancy.set_notifier(occupancy)
        devices.occupancy.set_lost_notifier(lost)
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
            orchestration,
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
            await services.devices.occupancy.refresh_all()
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
        await services.application.manual.close()
        await services.application.projects.close()
        await services.devices.close()
        await services.gateway.stop()
        await services.transports.close()
        await services.secrets.flush()


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()
