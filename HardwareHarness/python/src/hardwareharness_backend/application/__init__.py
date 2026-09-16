from __future__ import annotations

from typing import Any

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


class HardwareHarnessApplication:
    __test__ = False

    def __init__(self, dependencies: dict[str, Any]) -> None:
        execution = dependencies.get("execution") or ExecutionCoordinator()
        self.authorizer: Authorizer = dependencies.get("authorizer") or DefaultAuthorizer()
        self.devices = DevicesApplication(
            self.authorizer, dependencies["devices"], dependencies["catalog"], execution
        )
        self.projects = ProjectsApplication(
            self.authorizer,
            dependencies["projects"],
            dependencies["wiring"],
        )
        self.wiring = WiringApplication(
            self.authorizer, dependencies["projects"], dependencies["wiring"]
        )
        self.manual = ManualControlApplication(
            self.authorizer, dependencies["devices"], dependencies["catalog"], execution
        )
        self.system = SystemApplication(
            self.authorizer, dependencies["devices"], dependencies["system"], execution
        )
