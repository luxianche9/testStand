"""Composition root of the HardwareHarness service process.

Every caller (renderer, main process) runs ``@operation`` entries through one
``OperationRegistry`` over the local HTTP API and follows events on its SSE stream
(design doc §9.4). ``desktop.*`` are the main process's own operations.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from hardwareharness_backend import __version__
from hardwareharness_backend.application import (
    NAMESPACES,
    ExecutionCoordinator,
    HardwareHarnessApplication,
)
from hardwareharness_backend.application.registry import OperationRegistry, Payload
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.contracts.openapi import openapi_document
from hardwareharness_backend.contracts.operations import collect_operations
from hardwareharness_backend.devices import (
    DeviceCatalogService,
    DeviceService,
    DeviceStore,
    DeviceTransportRegistry,
    McpHttpTransport,
)
from hardwareharness_backend.host.change_events import change_summary
from hardwareharness_backend.host.desktop import DesktopApplication
from hardwareharness_backend.host.http_api import EventBus, LocalApi
from hardwareharness_backend.mcp_gateway import LocalMcpGateway
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.projects.icd_library import IcdLibrary
from hardwareharness_backend.storage import AuditLog, SecretBackend, SecretStore, SettingsStore
from hardwareharness_backend.storage.secrets import FileSecretBackend
from hardwareharness_backend.streams.live import LiveStreams
from hardwareharness_backend.streams.source import StreamSources, server_endpoints
from hardwareharness_backend.testing import TestEngine, TestPlanStore
from hardwareharness_backend.testing.plugins import load_plugins
from hardwareharness_backend.testing.resolver import DeviceToolResolver
from hardwareharness_backend.wiring import ProjectWiringService

SERVICE_NAMESPACES: dict[str, type] = {**NAMESPACES, "desktop": DesktopApplication}
SERVICE_OPERATIONS = collect_operations(SERVICE_NAMESPACES)
"""Every operation the service answers, the main process's ``desktop.*`` included."""
TEST_SECRETS_FILE = "secrets.test.json"


def openapi() -> dict[str, Any]:
    return openapi_document(SERVICE_OPERATIONS, __version__)


@dataclass
class ServiceOptions:
    user_data: Path
    gateway_port: int = 8000
    integration_test_mode: bool = False
    gateway_test_token: str | None = None
    secret_backend: SecretBackend | None = None
    """``None`` is the operating system's credential store."""


@dataclass
class Services:
    settings: SettingsStore
    secrets: SecretStore
    transports: DeviceTransportRegistry
    store: DeviceStore
    devices: DeviceService
    projects: ProjectService
    wiring: ProjectWiringService
    application: HardwareHarnessApplication
    desktop: DesktopApplication
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
        test_step_plugins = load_plugins("hardwareharness.test_steps")
        result_listeners = load_plugins("hardwareharness.result_listeners")
        test_resolver = DeviceToolResolver(devices, catalog, IcdLibrary(projects))
        test_plan_store = TestPlanStore(projects, test_resolver, test_step_plugins, wiring)
        stream_sources = StreamSources(server_endpoints(devices, secrets))
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
        desktop: DesktopApplication
        application = HardwareHarnessApplication(
            {
                "devices": devices,
                "catalog": catalog,
                "projects": projects,
                "wiring": wiring,
                "execution": execution,
                "system": SimpleNamespace(gateway_status=lambda: desktop.gateway.status()),
                "test_resolver": test_resolver,
                "test_plan_store": test_plan_store,
                "test_engine": test_engine,
                "test_step_plugins": test_step_plugins,
                "live_streams": live_streams,
            }
        )
        desktop = DesktopApplication(
            application.authorizer,
            settings,
            secrets,
            devices,
            projects,
            application,
            self.bus.publish,
        )
        registry = OperationRegistry(
            service_targets(application, desktop),
            SERVICE_OPERATIONS,
            audit=AuditLog(root / "audit.jsonl"),
            confirmer=application.system.confirmations,
        )
        application.system.confirmations.set_notifier(self._emit("confirmation"))
        gateway = LocalMcpGateway(application, secrets, options.gateway_port, operations=registry)
        desktop.bind_gateway(gateway)

        def publish_project(document: dict[str, Any] | None, workspace_changed: bool) -> None:
            self.bus.publish("project", change_summary("project", document))
            desktop.changed("project", workspaceChanged=workspace_changed)

        application.projects.set_notifier(publish_project)
        wiring.set_notifier(self._emit("wiringTask"))
        wiring.set_project_notifier(lambda: publish_project(projects.current(), False))
        execution.set_notifier(self._emit("execution"))
        application.testing.set_plan_notifier(self._emit("testPlan"))
        test_engine.set_notifier(self._emit("testRun"))
        application.testing.set_batch_notifier(self._emit("testBatch"))
        test_token = options.gateway_test_token
        if options.integration_test_mode and test_token and test_token.strip():
            await gateway.replace_token(test_token.strip())
        api = LocalApi(self.invoke, self.bus, openapi=openapi, live=live_streams.subscribe)
        await gateway.start()
        try:
            await api.start()
        except BaseException:
            await gateway.stop()
            raise
        self.services = Services(
            settings,
            secrets,
            transports,
            store,
            devices,
            projects,
            wiring,
            application,
            desktop,
            registry,
            gateway,
            stream_sources,
            live_streams,
            api,
        )
        gateway.set_change_notifier(lambda: desktop.changed("gateway"))
        return self.services

    def _emit(self, event: str) -> Callable[[Any], None]:
        def publish(payload: Any) -> None:
            self.bus.publish(event, change_summary(event, payload))

        return publish

    def handshake(self) -> dict[str, Any]:
        """The one stdout line the main process reads before it talks HTTP."""
        api = self.require_services().api
        return {
            "port": api.port,
            "token": api.token,
            "hostToken": api.host_token,
            "version": __version__,
        }

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
        await services.stream_sources.close()
        await services.application.projects.close()
        await services.devices.close()
        await services.transports.close()
        await services.secrets.flush()


def service_targets(application: HardwareHarnessApplication, desktop: DesktopApplication) -> Any:
    """What the registry dispatches on: every application namespace plus ``desktop``."""
    return SimpleNamespace(
        authorizer=application.authorizer,
        desktop=desktop,
        **{namespace: getattr(application, namespace) for namespace in NAMESPACES},
    )
