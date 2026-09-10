from __future__ import annotations

from typing import Any, Protocol

from testforge_backend.contracts.agents import CAPABILITIES
from testforge_backend.contracts.errors import app_error

Json = dict[str, Any]
HUMAN_REQUEST_CONTEXT: Json = {"actor": "human", "source": "desktop"}
AGENT_REQUEST_CONTEXT: Json = {"actor": "agent", "source": "mcp"}
SYSTEM_REQUEST_CONTEXT: Json = {"actor": "system", "source": "internal"}
_AGENT_CAPABILITIES = {
    "system.read",
    "devices.read",
    "devices.controlServers",
    "hardware.read",
    "hardware.manage",
    "hardware.executeTools",
    "hardware.readOccupancy",
    "hardware.requestOccupancy",
    "projects.read",
    "projects.manage",
    "wiring.read",
    "wiring.request",
    "orchestration.read",
    "orchestration.manage",
    "orchestration.run",
}


class Authorizer(Protocol):
    def is_allowed(self, context: Json, capability: str) -> bool: ...
    def authorize(self, context: Json, capability: str) -> None: ...
    def allowed_capabilities(self, context: Json) -> list[str]: ...


class DefaultAuthorizer:
    def is_allowed(self, context: Json, capability: str) -> bool:
        return context["actor"] in {"human", "system"} or capability in _AGENT_CAPABILITIES

    def authorize(self, context: Json, capability: str) -> None:
        if not self.is_allowed(context, capability):
            raise app_error(
                "permission_denied",
                f"{context['actor']} is not authorized for capability {capability}",
                {"capability": capability},
            )

    def allowed_capabilities(self, context: Json) -> list[str]:
        return [capability for capability in CAPABILITIES if self.is_allowed(context, capability)]
