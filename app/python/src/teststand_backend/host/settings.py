"""User settings and the model settings of the embedded OpenCode (design doc §9.6.1).

``system.manage`` is a human capability: the renderer may call these, an Agent never.
"""

from __future__ import annotations

import logging
from typing import Literal

from teststand_backend.application import Authorizer
from teststand_backend.contracts.operations import operation
from teststand_backend.storage import SecretStore, SettingsStore
from teststand_backend.util import UNDEFINED, Record

from .opencode import LlmChoice, OpenCodeRuntime

LLM_SECRET = "opencode.llm.api-key"
log = logging.getLogger(__name__)


class SettingsApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        settings: SettingsStore,
        secrets: SecretStore,
        opencode: OpenCodeRuntime,
    ) -> None:
        self.authorizer = authorizer
        self.settings = settings
        self.secrets = secrets
        self.opencode = opencode

    def llm_choice(self) -> LlmChoice:
        """The model settings and key OpenCode starts with."""
        llm = self.settings.get()["llm"]
        key = None
        if self.secrets.has(LLM_SECRET):
            value = self.secrets.get(LLM_SECRET).get("apiKey", UNDEFINED)
            key = value if isinstance(value, str) and value else None
        return LlmChoice(llm["baseUrl"], llm["model"], key)

    @operation("settings.get", capability="system.manage", risk="read")
    def get(self, context: Record) -> Record:
        """Theme, layouts, recent projects and the model settings (never the key)."""
        return self.settings.get()

    @operation("settings.update", capability="system.manage", risk="write")
    async def update(
        self,
        context: Record,
        theme: Literal["system", "light", "dark"] | None = None,
        project_view: Literal["bench", "plans", "runs"] | None = None,
        welcome_layout: Literal["grid", "list"] | None = None,
    ) -> Record:
        patch = {
            key: value
            for key, value in (
                ("theme", theme),
                ("projectView", project_view),
                ("welcomeLayout", welcome_layout),
            )
            if value is not None
        }
        return await self.settings.update(patch)

    @operation("settings.getLlm", capability="system.manage", risk="read")
    def get_llm(self, context: Record) -> Record:
        return {**self.settings.get()["llm"], "apiKeyConfigured": self.secrets.has(LLM_SECRET)}

    @operation("settings.saveLlm", capability="system.manage", risk="write")
    async def save_llm(
        self,
        context: Record,
        base_url: str,
        model: str,
        api_key: str | None = None,
        clear_api_key: bool = False,
    ) -> Record:
        """Save the OpenCode model settings; the key goes to the credential store. OpenCode
        restarts, starts or stops to match, after this returns."""
        before = self._snapshot()
        try:
            llm = {"baseUrl": base_url.strip(), "model": model.strip()}
            await self.settings.update({"llm": llm})
            key = api_key.strip() if isinstance(api_key, str) else ""
            if clear_api_key:
                await self.secrets.remove(LLM_SECRET)
            elif key:
                await self.secrets.set(LLM_SECRET, {"apiKey": key})
        finally:
            after = self._snapshot()
            if before is not None and after is not None:
                self.opencode.schedule(lambda: self.opencode.settings_changed(before, after))
        return self.get_llm(context)

    def _snapshot(self) -> LlmChoice | None:
        try:
            return self.llm_choice()
        except Exception:
            log.exception("The LLM key cannot be read")
            return None
