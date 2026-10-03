"""Agents: the embedded OpenCode runtime, the gateway's tools and the Codex connection.

``agents.manage`` is a human capability: the renderer may call these, an Agent never. The
main process reads ``agents.openCodeConnection`` to authenticate the renderer's requests to
OpenCode; nothing else needs the OpenCode password.
"""

from __future__ import annotations

from typing import Any, Literal, Protocol

from teststand_backend.application import AGENT_REQUEST_CONTEXT, Authorizer
from teststand_backend.contracts.errors import AppError
from teststand_backend.contracts.operations import operation
from teststand_backend.util import Record

from .codex import CodexIntegration
from .opencode import OpenCodeRuntime

AgentKind = Literal["codex"]


class Gateway(Protocol):
    def status(self) -> Record: ...
    def token(self) -> str: ...
    async def rotate_token(self) -> str: ...
    async def replace_token(self, token: str) -> None: ...
    def list_builtin_tools(self) -> list[Record]: ...


class AgentsApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        opencode: OpenCodeRuntime,
        codex: CodexIntegration,
        application: Any,
    ) -> None:
        self.authorizer = authorizer
        self.opencode = opencode
        self.codex = codex
        self.application = application
        self._gateway: Gateway | None = None

    def bind_gateway(self, gateway: Gateway) -> None:
        """The gateway is built from the operation registry, so it arrives after this."""
        self._gateway = gateway

    @property
    def gateway(self) -> Gateway:
        if self._gateway is None:
            raise AppError("unavailable", "The MCP gateway is not ready")
        return self._gateway

    @operation("agents.listTools", capability="agents.manage", risk="read")
    def list_tools(self, context: Record) -> list[Record]:
        """Built-in gateway tools plus the device tools the Agent may call."""
        builtins = [
            {
                "name": tool["name"],
                "kind": "builtin",
                "inputSchema": tool["inputSchema"],
                **({"description": tool["description"]} if tool.get("description") else {}),
            }
            for tool in self.gateway.list_builtin_tools()
        ]
        remote = [
            {
                "name": tool["externalName"],
                "kind": "remote",
                "inputSchema": tool["inputSchema"],
                "deviceId": tool["deviceId"],
                "remoteName": tool["remoteName"],
                **({"description": tool["description"]} if tool.get("description") else {}),
            }
            for tool in self.application.devices.list_tools(AGENT_REQUEST_CONTEXT)
        ]
        return [*builtins, *remote]

    @operation("agents.openCodeStatus", capability="agents.manage", risk="read")
    def open_code_status(self, context: Record) -> Record:
        return self.opencode.status()

    @operation("agents.openCodeConnection", capability="agents.manage", risk="read")
    def open_code_connection(self, context: Record) -> Record | None:
        """``{url, username, password}`` of the running OpenCode instance, or null."""
        return self.opencode.connection()

    @operation("agents.startOpenCode", capability="agents.manage", risk="write")
    async def start_open_code(self, context: Record) -> Record:
        return await self.opencode.start()

    @operation("agents.stopOpenCode", capability="agents.manage", risk="write")
    async def stop_open_code(self, context: Record) -> Record:
        return await self.opencode.stop()

    @operation("agents.restartOpenCode", capability="agents.manage", risk="write")
    async def restart_open_code(self, context: Record) -> Record:
        return await self.opencode.restart()

    @operation("agents.status", capability="agents.manage", risk="read")
    async def status(self, context: Record, agent: AgentKind) -> Record:
        """Whether Codex is connected to this gateway, and what is missing."""
        return await self.codex.status()

    @operation("agents.preview", capability="agents.manage", risk="read")
    async def preview(self, context: Record, agent: AgentKind) -> Record:
        return await self.codex.preview()

    @operation("agents.install", capability="agents.manage", risk="write")
    async def install(self, context: Record, agent: AgentKind) -> Record:
        return await self.codex.install()

    @operation("agents.remove", capability="agents.manage", risk="destructive")
    async def remove(self, context: Record, agent: AgentKind) -> Record:
        return await self.codex.remove()

    @operation("agents.test", capability="agents.manage", risk="read")
    async def test(self, context: Record, agent: AgentKind) -> Record:
        return await self.codex.test()

    @operation("agents.rotateGatewayToken", capability="agents.manage", risk="write")
    async def rotate_gateway_token(self, context: Record) -> Record:
        """A new gateway token for Codex and OpenCode (which restarts to pick it up)."""
        result = await self.codex.rotate_token()
        self.opencode.schedule(self.opencode.gateway_token_changed)
        return result
