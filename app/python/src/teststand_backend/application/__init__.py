from __future__ import annotations

from typing import Any

from teststand_backend.contracts.operations import collect_operations
from teststand_backend.projects.icd_library import IcdLibrary
from teststand_backend.testing import TestEngine, TestingApplication, TestPlanStore
from teststand_backend.testing.resolver import DeviceToolResolver

from .authorization import (
    AGENT_REQUEST_CONTEXT as AGENT_REQUEST_CONTEXT,
)
from .authorization import (
    HUMAN_REQUEST_CONTEXT as HUMAN_REQUEST_CONTEXT,
)
from .authorization import (
    SYSTEM_REQUEST_CONTEXT as SYSTEM_REQUEST_CONTEXT,
)
from .authorization import (
    Authorizer as Authorizer,
)
from .authorization import (
    DefaultAuthorizer as DefaultAuthorizer,
)
from .control import (
    ManualControlApplication as ManualControlApplication,
)
from .execution import ExecutionCoordinator as ExecutionCoordinator
from .execution import ExecutionHandle as ExecutionHandle
from .services import (
    ApplicationSystemPort as ApplicationSystemPort,
)
from .services import (
    DevicesApplication as DevicesApplication,
)
from .services import (
    ProjectsApplication as ProjectsApplication,
)
from .services import (
    SystemApplication as SystemApplication,
)
from .services import (
    WiringApplication as WiringApplication,
)
from .signals import SignalsApplication as SignalsApplication
from .streams import StreamsApplication as StreamsApplication

NAMESPACES: dict[str, type] = {
    "devices": DevicesApplication,
    "streams": StreamsApplication,
    "projects": ProjectsApplication,
    "wiring": WiringApplication,
    "signals": SignalsApplication,
    "manual": ManualControlApplication,
    "testing": TestingApplication,
    "system": SystemApplication,
}
OPERATIONS = collect_operations(NAMESPACES)
"""Every ``@operation`` by its wire name ``namespace.camelMethod``, collected once."""


class TestStandApplication:
    __test__ = False

    def __init__(self, dependencies: dict[str, Any]) -> None:
        execution = dependencies.get("execution") or ExecutionCoordinator()
        test_resolver = dependencies.get("test_resolver") or DeviceToolResolver(
            dependencies["devices"], dependencies["catalog"], IcdLibrary(dependencies["projects"])
        )
        test_plan_store = dependencies.get("test_plan_store") or TestPlanStore(
            dependencies["projects"],
            test_resolver,
            dependencies.get("test_step_plugins", []),
            dependencies.get("wiring"),
        )
        test_engine = dependencies.get("test_engine") or TestEngine(
            dependencies["projects"],
            dependencies["devices"],
            test_resolver,
            execution,
            dependencies.get("test_step_plugins", []),
            runtime_state=test_plan_store.runtime,
        )
        self.authorizer: Authorizer = dependencies.get("authorizer") or DefaultAuthorizer()
        self.devices = DevicesApplication(
            self.authorizer, dependencies["devices"], dependencies["catalog"], execution
        )
        self.streams = StreamsApplication(
            self.authorizer,
            dependencies["devices"],
            dependencies.get("live_streams"),
            runs=test_engine,
        )
        self.projects = ProjectsApplication(
            self.authorizer,
            dependencies["projects"],
            dependencies["wiring"],
            execution,
        )
        self.wiring = WiringApplication(
            self.authorizer, dependencies["projects"], dependencies["wiring"]
        )
        self.manual = ManualControlApplication(
            self.authorizer, dependencies["devices"], dependencies["catalog"], execution
        )
        self.signals = SignalsApplication(
            self.authorizer,
            dependencies["projects"],
            dependencies["wiring"],
            dependencies["catalog"],
            dependencies["devices"],
            self.manual,
        )
        self.testing = TestingApplication(
            self.authorizer,
            test_plan_store,
            test_engine,
            test_resolver,
            dependencies["wiring"],
            dependencies.get("test_step_plugins", []),
        )
        self.system = SystemApplication(
            self.authorizer,
            dependencies["devices"],
            dependencies["system"],
            execution,
            dependencies.get("confirmations"),
        )
