"""``settings.*`` and ``agents.*``: the desktop's own operations, callable with the one token."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from teststand_backend.application import (
    AGENT_REQUEST_CONTEXT,
    HUMAN_REQUEST_CONTEXT,
    DefaultAuthorizer,
)
from teststand_backend.contracts.errors import AppError
from teststand_backend.host.agents import AgentsApplication
from teststand_backend.host.opencode import LlmChoice
from teststand_backend.host.settings import LLM_SECRET, SettingsApplication
from teststand_backend.storage import SecretStore, SettingsStore
from teststand_backend.storage.secrets import MemorySecretBackend


class OpenCode:
    def __init__(self) -> None:
        self.changes: list[tuple[LlmChoice, LlmChoice]] = []
        self.scheduled: list[Any] = []

    def schedule(self, action: Any) -> None:
        self.scheduled.append(action)

    async def settings_changed(self, before: LlmChoice, after: LlmChoice) -> None:
        self.changes.append((before, after))


async def settings_application(tmp_path: Path) -> tuple[SettingsApplication, OpenCode]:
    settings = SettingsStore(tmp_path / "settings.json")
    await settings.initialize()
    secrets = SecretStore(tmp_path, MemorySecretBackend())
    await secrets.initialize()
    opencode = OpenCode()
    return SettingsApplication(DefaultAuthorizer(), settings, secrets, opencode), opencode  # type: ignore[arg-type]


async def test_settings_update_only_what_was_given(tmp_path: Path) -> None:
    application, _ = await settings_application(tmp_path)
    context = dict(HUMAN_REQUEST_CONTEXT)
    updated = await application.update(context, theme="dark")
    assert updated["theme"] == "dark" and updated["welcomeLayout"] == "grid"
    updated = await application.update(context, project_view="runs", welcome_layout="list")
    assert (updated["theme"], updated["projectView"], updated["welcomeLayout"]) == (
        "dark",
        "runs",
        "list",
    )
    assert application.get(context) == updated


async def test_saving_the_model_settings_reconciles_opencode_afterwards(tmp_path: Path) -> None:
    application, opencode = await settings_application(tmp_path)
    context = dict(HUMAN_REQUEST_CONTEXT)
    saved = await application.save_llm(context, " https://llm/v1 ", " m ", api_key=" key ")
    assert saved == {"baseUrl": "https://llm/v1", "model": "m", "apiKeyConfigured": True}
    assert application.llm_choice() == LlmChoice("https://llm/v1", "m", "key")
    [action] = opencode.scheduled
    await action()
    assert opencode.changes == [
        (
            LlmChoice("https://api.openai.com/v1", "gpt-4.1", None),
            LlmChoice("https://llm/v1", "m", "key"),
        )
    ]
    cleared = await application.save_llm(context, "https://llm/v1", "m", clear_api_key=True)
    assert cleared["apiKeyConfigured"] is False
    assert application.llm_choice().api_key is None


async def test_an_unreadable_key_skips_the_reconciliation(tmp_path: Path) -> None:
    application, opencode = await settings_application(tmp_path)
    await application.secrets.set(LLM_SECRET, {"apiKey": "key"})
    application.secrets.get = MagicMock(side_effect=RuntimeError("locked"))  # type: ignore[method-assign]
    await application.save_llm(dict(HUMAN_REQUEST_CONTEXT), "https://llm/v1", "m")
    assert opencode.scheduled == []


async def test_an_agent_may_not_change_settings(tmp_path: Path) -> None:
    application, _ = await settings_application(tmp_path)
    with pytest.raises(AppError) as denied:
        await application.update(dict(AGENT_REQUEST_CONTEXT), theme="dark")
    assert denied.value.category == "permission_denied"


async def test_agents_operations_delegate_to_opencode_and_codex() -> None:
    opencode = MagicMock()
    opencode.status.return_value = {"state": "stopped"}
    opencode.connection.return_value = None
    for name in ("start", "stop", "restart"):
        setattr(opencode, name, MagicMock(side_effect=lambda: asyncio.sleep(0, {"state": "x"})))
    codex = MagicMock()
    for name in ("status", "preview", "install", "remove", "test", "rotate_token"):
        setattr(codex, name, MagicMock(side_effect=lambda: asyncio.sleep(0, {"agent": "codex"})))
    devices = MagicMock()
    devices.list_tools.return_value = [
        {
            "externalName": "ext",
            "inputSchema": {},
            "deviceId": "S",
            "remoteName": "remote",
            "description": "d",
        }
    ]
    agents = AgentsApplication(DefaultAuthorizer(), opencode, codex, MagicMock(devices=devices))
    context = dict(HUMAN_REQUEST_CONTEXT)
    with pytest.raises(AppError, match="not ready"):
        agents.list_tools(context)
    gateway = MagicMock()
    gateway.list_builtin_tools.return_value = [{"name": "b", "inputSchema": {}}]
    agents.bind_gateway(gateway)
    assert agents.list_tools(context) == [
        {"name": "b", "kind": "builtin", "inputSchema": {}},
        {
            "name": "ext",
            "kind": "remote",
            "inputSchema": {},
            "deviceId": "S",
            "remoteName": "remote",
            "description": "d",
        },
    ]
    assert agents.open_code_status(context) == {"state": "stopped"}
    assert agents.open_code_connection(context) is None
    for call in (agents.start_open_code, agents.stop_open_code, agents.restart_open_code):
        assert await call(context) == {"state": "x"}
    for method in (agents.status, agents.preview, agents.install, agents.remove, agents.test):
        assert await method(context, "codex") == {"agent": "codex"}
    assert await agents.rotate_gateway_token(context) == {"agent": "codex"}
    opencode.schedule.assert_called_once_with(opencode.gateway_token_changed)
    with pytest.raises(AppError):
        agents.open_code_connection(dict(AGENT_REQUEST_CONTEXT))
