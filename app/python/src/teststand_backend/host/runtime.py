"""Composition root of the testStand service process.

Every caller (the renderer, the main process) runs ``@operation`` entries through one
``OperationRegistry`` over the local HTTP API and follows events on its SSE stream
(design doc §9.4). The service also owns the embedded OpenCode runtime and the periodic
device availability check.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from teststand_backend import __version__
from teststand_backend.application import (
    NAMESPACES,
    ExecutionCoordinator,
    TestStandApplication,
)
from teststand_backend.application.registry import OperationRegistry, Payload
from teststand_backend.contracts.errors import AppError
from teststand_backend.contracts.operations import collect_operations
from teststand_backend.devices import (
    DeviceCatalogService,
    DeviceService,
    DeviceStore,
    PluginStore,
    PluginTransport,
)
from teststand_backend.host.agents import AgentsApplication
from teststand_backend.host.change_events import change_summary
from teststand_backend.host.codex import (
    CodexIntegration,
    MemoryCodexRunner,
    MemoryUserEnvironment,
)
from teststand_backend.host.http_api import EventBus, LocalApi
from teststand_backend.host.opencode import OpenCodeRuntime
from teststand_backend.host.settings import SettingsApplication
from teststand_backend.mcp_gateway import LocalMcpGateway
from teststand_backend.projects import ProjectService
from teststand_backend.projects.icd_library import IcdLibrary
from teststand_backend.storage import AuditLog, SecretBackend, SecretStore, SettingsStore
from teststand_backend.storage.secrets import FileSecretBackend
from teststand_backend.streams.live import LiveStreams
from teststand_backend.streams.source import StreamSources
from teststand_backend.testing import TestEngine, TestPlanStore
from teststand_backend.testing.plugins import load_plugins
from teststand_backend.testing.resolver import DeviceToolResolver
from teststand_backend.wiring import ProjectWiringService

SERVICE_NAMESPACES: dict[str, type] = {
    **NAMESPACES,
    "settings": SettingsApplication,
    "agents": AgentsApplication,
}
SERVICE_OPERATIONS = collect_operations(SERVICE_NAMESPACES)
"""Every operation the service answers: the application's plus ``settings.*`` and
``agents.*``, which only exist in the desktop service."""
TEST_SECRETS_FILE = "secrets.test.json"
AVAILABILITY_INTERVAL_S = 10.0
"""How often every device is checked. Plugins report a fault only when asked, so this is
the one place that notices a device going away; views follow the ``availability`` event."""


@dataclass
class ServiceOptions:
    user_data: Path
    gateway_port: int = 8000
    integration_test_mode: bool = False
    gateway_test_token: str | None = None
    opencode: Path | None = None
    """The bundled OpenCode executable; the main process knows where it was installed."""
    renderer_origins: tuple[str, ...] = ()
    """Origins the renderer's requests come from (CORS for this API and for OpenCode)."""
    secret_backend: SecretBackend | None = None
    """``None`` is the operating system's credential store."""


@dataclass
class Services:
    settings: SettingsStore
    secrets: SecretStore
    plugins: PluginTransport
    store: DeviceStore
    devices: DeviceService
    projects: ProjectService
    wiring: ProjectWiringService
    application: TestStandApplication
    settings_application: SettingsApplication
    agents: AgentsApplication
    opencode: OpenCodeRuntime
    registry: OperationRegistry
    gateway: LocalMcpGateway
    stream_sources: StreamSources
    live_streams: LiveStreams
    api: LocalApi


class HostRuntime:
    def __init__(self) -> None:
        self.bus = EventBus()
        self.services: Services | None = None
        self._shutdown: asyncio.Task[None] | None = None
        self._availability: asyncio.Task[None] | None = None

    def require_services(self) -> Services:
        if self.services is None:
            raise AppError("unavailable", "The service is not ready")
        return self.services

    async def initialize(self, options: ServiceOptions) -> Services:
        if self.services is not None:
            raise AppError("conflict", "The service is already initialized")
        root = options.user_data
        root.mkdir(parents=True, exist_ok=True)
        settings = SettingsStore(root / "settings.json")
        await settings.initialize()
        backend = options.secret_backend
        if backend is None and options.integration_test_mode:
            # End-to-end runs must never touch the real credential store.
            backend = FileSecretBackend(root / TEST_SECRETS_FILE)
        secrets = SecretStore(root, backend)
        await secrets.initialize()
        # Installed device packages go on sys.path before any device type is imported.
        packages = PluginStore(root / "plugins")
        await packages.initialize()
        plugins = PluginTransport()
        store = DeviceStore(root / "devices")
        await store.initialize()
        devices = DeviceService(store, plugins, packages)
        projects = ProjectService(settings)
        await projects.initialize()
        catalog = DeviceCatalogService(store)
        wiring = ProjectWiringService(projects, catalog)
        await wiring.initialize()
        execution = ExecutionCoordinator()
        test_step_plugins = load_plugins("teststand.test_steps")
        result_listeners = load_plugins("teststand.result_listeners")
        test_resolver = DeviceToolResolver(devices, catalog, IcdLibrary(projects))
        test_plan_store = TestPlanStore(projects, test_resolver, test_step_plugins, wiring)
        stream_sources = StreamSources(plugins.device_for)
        live_root = root / "live-streams"
        live_root.mkdir(exist_ok=True)
        for stale in live_root.glob("*.sqlite*"):
            with contextlib.suppress(OSError):
                stale.unlink()
        live_streams = LiveStreams(
            stream_sources,
            live_root,
            list_streams=devices.list_streams,
            fetch_blob=devices.read_blob,
        )
        test_engine = TestEngine(
            projects,
            devices,
            test_resolver,
            execution,
            test_step_plugins,
            result_listeners,
            runtime_state=test_plan_store.runtime,
            stream_sources=stream_sources,
        )
        agents: AgentsApplication
        application = TestStandApplication(
            {
                "devices": devices,
                "catalog": catalog,
                "projects": projects,
                "wiring": wiring,
                "execution": execution,
                "system": SimpleNamespace(gateway_status=lambda: agents.gateway.status()),
                "test_resolver": test_resolver,
                "test_plan_store": test_plan_store,
                "test_engine": test_engine,
                "test_step_plugins": test_step_plugins,
                "live_streams": live_streams,
            }
        )
        opencode = OpenCodeRuntime(
            [str(options.opencode)] if options.opencode and options.opencode.is_file() else None,
            root / "opencode",
            workspace=lambda: (projects.current() or {}).get("rootPath"),
            llm=lambda: settings_application.llm_choice(),
            gateway_endpoint=lambda: agents.gateway.status()["endpoint"],
            gateway_token=lambda: agents.gateway.token(),
            cors_origins=options.renderer_origins,
            publish=self._emit("opencode"),
        )
        settings_application = SettingsApplication(
            application.authorizer, settings, secrets, opencode
        )
        test_mode = options.integration_test_mode
        codex = CodexIntegration(
            lambda: agents.gateway,
            root / "agent-config-backups",
            runner=MemoryCodexRunner() if test_mode else None,
            environment=MemoryUserEnvironment() if test_mode else None,
            codex_cli="test-codex.exe" if test_mode else None,
            codex_home=root / "codex-test-home" if test_mode else None,
        )
        agents = AgentsApplication(application.authorizer, opencode, codex, application)
        registry = OperationRegistry(
            service_targets(application, settings_application, agents),
            SERVICE_OPERATIONS,
            audit=AuditLog(root / "audit.jsonl"),
            confirmer=application.system.confirmations,
        )
        application.system.confirmations.set_notifier(self._emit("confirmation"))
        gateway = LocalMcpGateway(application, secrets, options.gateway_port, operations=registry)
        agents.bind_gateway(gateway)

        def publish_project(document: dict[str, Any] | None, workspace_changed: bool) -> None:
            self.bus.publish("project", change_summary("project", document))
            if workspace_changed:
                opencode.schedule(opencode.workspace_changed)

        application.projects.set_notifier(publish_project)
        wiring.set_notifier(self._emit("wiringTask"))
        wiring.set_project_notifier(lambda: publish_project(projects.current(), False))
        execution.set_notifier(self._emit("execution"))
        application.testing.set_plan_notifier(self._emit("testPlan"))
        test_engine.set_notifier(self._emit("testRun"))
        store.set_notifier(self._signal("devices"))
        test_token = options.gateway_test_token
        if options.integration_test_mode and test_token and test_token.strip():
            await gateway.replace_token(test_token.strip())
        api = LocalApi(
            self.invoke, self.bus, origins=options.renderer_origins, live=live_streams.subscribe
        )
        await gateway.start()
        try:
            await api.start()
        except BaseException:
            await gateway.stop()
            raise
        self.services = Services(
            settings,
            secrets,
            plugins,
            store,
            devices,
            projects,
            wiring,
            application,
            settings_application,
            agents,
            opencode,
            registry,
            gateway,
            stream_sources,
            live_streams,
            api,
        )
        gateway.set_change_notifier(self._signal("gateway"))
        self._availability = asyncio.create_task(self._watch_availability(devices))
        opencode.schedule(opencode.autostart)
        return self.services

    async def _watch_availability(self, devices: DeviceService) -> None:
        """Check every device now and every ``AVAILABILITY_INTERVAL_S``; publish
        ``availability`` when a device's state or message changed."""
        last: object = None
        while True:
            await asyncio.gather(
                *(devices.refresh_device(item["deviceId"]) for item in devices.list_devices()),
                return_exceptions=True,
            )
            current = sorted(
                (item["hardwareId"], item["state"], item.get("message"))
                for item in devices.list_availability()
            )
            if current != last:
                last = current
                self.bus.publish("availability", {})
            await asyncio.sleep(AVAILABILITY_INTERVAL_S)

    def _signal(self, event: str) -> Callable[[], None]:
        """A change with nothing to identify: views refetch everything ``event`` covers."""

        def publish() -> None:
            self.bus.publish(event, {})

        return publish

    def _emit(self, event: str) -> Callable[[Any], None]:
        def publish(payload: Any) -> None:
            self.bus.publish(event, change_summary(event, payload))

        return publish

    def handshake(self) -> dict[str, Any]:
        """The one stdout line the main process reads before it talks HTTP."""
        api = self.require_services().api
        return {"port": api.port, "token": api.token, "version": __version__}

    async def invoke(self, context: dict[str, Any], name: str, payload: Payload) -> Any:
        services = self.require_services()
        if self._shutdown is not None:
            raise AppError("unavailable", "The service is shutting down")
        return await services.registry.invoke(context, name, payload)

    async def close(self) -> None:
        if self._shutdown is None:
            self._shutdown = asyncio.create_task(self._close())
        await self._shutdown

    async def _close(self) -> None:
        if self.services is None:
            return
        services = self.services
        if self._availability is not None:
            self._availability.cancel()
            await asyncio.gather(self._availability, return_exceptions=True)
        await services.opencode.close()
        await services.api.stop()
        self.bus.close()
        services.application.system.confirmations.set_notifier(lambda _pending: None)
        services.application.system.confirmations.close()
        await services.gateway.stop()
        await services.application.devices.close_calls()
        await services.application.manual.close()
        # Exit order: runs abort and clean up (their safe_state), then every device goes safe.
        await services.application.testing.close()
        await services.devices.safe_all()
        await services.live_streams.close()
        await services.application.projects.close()
        await services.plugins.close()
        await services.secrets.flush()


def service_targets(application: TestStandApplication, settings: Any, agents: Any) -> Any:
    """What the registry dispatches on: every application namespace, ``settings`` and
    ``agents``."""
    return SimpleNamespace(
        authorizer=application.authorizer,
        settings=settings,
        agents=agents,
        **{namespace: getattr(application, namespace) for namespace in NAMESPACES},
    )
