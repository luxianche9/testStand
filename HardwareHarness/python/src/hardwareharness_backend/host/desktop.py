"""Operations only the desktop main process calls (design doc §9.6.1).

Main keeps OpenCode, so it needs the settings, the gateway token and the LLM key. It reads
them with ``desktop.state`` over the same HTTP API as the renderer, but these operations
need the host token, which main never hands to the renderer. ``system.manage`` and
``agents.manage`` are human capabilities: an Agent is never granted them.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, Protocol

from hardwareharness_backend.application import AGENT_REQUEST_CONTEXT, Authorizer
from hardwareharness_backend.contracts.errors import AppError, to_wire_error
from hardwareharness_backend.contracts.operations import operation
from hardwareharness_backend.devices import DeviceService, DeviceStore
from hardwareharness_backend.projects import ProjectService
from hardwareharness_backend.storage import SecretStore, SettingsStore
from hardwareharness_backend.util import UNDEFINED, Record, clone

LLM_SECRET = "opencode.llm.api-key"
Publish = Callable[[str, Any], object]


class Gateway(Protocol):
    def status(self) -> Record: ...
    def token(self) -> str: ...
    async def rotate_token(self) -> str: ...
    async def replace_token(self, token: str) -> None: ...
    def list_builtin_tools(self) -> list[Record]: ...


class DesktopApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        settings: SettingsStore,
        secrets: SecretStore,
        store: DeviceStore,
        devices: DeviceService,
        projects: ProjectService,
        application: Any,
        publish: Publish,
    ) -> None:
        self.authorizer = authorizer
        self.settings = settings
        self.secrets = secrets
        self.store = store
        self.devices = devices
        self.projects = projects
        self.application = application
        self.publish = publish
        self.generation = 0
        self._gateway: Gateway | None = None

    def bind_gateway(self, gateway: Gateway) -> None:
        """The gateway is built from the application, so it arrives after construction."""
        self._gateway = gateway

    @property
    def gateway(self) -> Gateway:
        if self._gateway is None:
            raise AppError("unavailable", "The MCP gateway is not ready")
        return self._gateway

    def changed(self, reason: str, **details: Any) -> None:
        """Tell main to read ``desktop.state`` again."""
        self.publish("state", {"reason": reason, **details})

    @operation("desktop.state", capability="system.manage", risk="read")
    def state(self, context: Record) -> Record:
        """Settings, gateway, open project and the LLM key, for the main process."""
        self.generation += 1
        result: Record = {
            "generation": self.generation,
            "settings": self.settings.get(),
            "gateway": self.gateway.status(),
            "gatewayToken": self.gateway.token(),
            "llmApiKeyConfigured": self.secrets.has(LLM_SECRET),
        }
        project = self.projects.current()
        if project is not None:
            result["project"] = clone(project)
        if self.secrets.has(LLM_SECRET):
            try:
                key = self.secrets.get(LLM_SECRET).get("apiKey", UNDEFINED)
                if key is not UNDEFINED:
                    result["llmApiKey"] = key
            except Exception as error:
                result["llmApiKeyError"] = to_wire_error(error)
        return result

    @operation("desktop.updateSettings", capability="system.manage", risk="write")
    async def update_settings(self, context: Record, patch: Record) -> Record:
        try:
            return await self.settings.update(patch)
        finally:
            self.changed("settings")

    @operation("desktop.saveLlm", capability="system.manage", risk="write")
    async def save_llm(
        self,
        context: Record,
        base_url: str,
        model: str,
        api_key: str | None = None,
        clear_api_key: bool = False,
    ) -> Record:
        """Save the OpenCode model settings; the key goes to the credential store."""
        try:
            await self.settings.update({"llm": {"baseUrl": base_url, "model": model}})
            key = api_key.strip() if isinstance(api_key, str) else ""
            if clear_api_key:
                await self.secrets.remove(LLM_SECRET)
            elif key:
                await self.secrets.set(LLM_SECRET, {"apiKey": key})
        finally:
            self.changed("settings")
        return {**self.settings.get()["llm"], "apiKeyConfigured": self.secrets.has(LLM_SECRET)}

    @operation("desktop.rotateGatewayToken", capability="agents.manage", risk="write")
    async def rotate_gateway_token(self, context: Record) -> str:
        return await self.gateway.rotate_token()

    @operation("desktop.replaceGatewayToken", capability="agents.manage", risk="write")
    async def replace_gateway_token(self, context: Record, token: str) -> None:
        await self.gateway.replace_token(token)

    @operation("desktop.resolveImagePath", capability="system.manage", risk="read")
    def resolve_image_path(self, context: Record, hardware_id: str, asset_id: str) -> str:
        """Local path of a hardware image, for the ``hardwareharness-asset:`` protocol."""
        return str(self.store.image_path(hardware_id, asset_id))

    @operation("desktop.probeAvailability", capability="system.manage", risk="read")
    async def probe_availability(self, context: Record) -> Record:
        """Refresh every MCP server once, as the Agent sees them, after startup."""
        results = await asyncio.gather(
            *(
                self.application.devices.refresh_server(AGENT_REQUEST_CONTEXT, server["serverId"])
                for server in self.devices.list_servers()
            ),
            return_exceptions=True,
        )
        return {
            "availability": self.devices.list_availability(),
            "servers": [result for result in results if not isinstance(result, BaseException)],
        }

    @operation("desktop.listAgentTools", capability="agents.manage", risk="read")
    def list_agent_tools(self, context: Record) -> list[Record]:
        """Built-in gateway tools plus the remote tools the Agent may call."""
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
                "serverId": tool["serverId"],
                "remoteName": tool["remoteName"],
                **({"description": tool["description"]} if tool.get("description") else {}),
            }
            for tool in self.application.devices.list_tools(AGENT_REQUEST_CONTEXT)
        ]
        return [*builtins, *remote]
