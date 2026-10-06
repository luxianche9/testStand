"""OpenCode, the desktop's embedded agent runtime (design doc §9.4).

The service starts ``opencode serve`` in the open project's folder with an isolated XDG
profile under the user data directory. The model provider, the testStand MCP gateway
and the agent instructions are passed as ``OPENCODE_CONFIG_CONTENT``; the LLM key and the
gateway token only through the environment (the configuration names them ``{env:...}``).
OpenCode listens on a random 127.0.0.1 port behind HTTP Basic auth; the password is generated
once per service process and handed only to the main process (``agents.openCodeConnection``),
which adds it to the renderer's requests.

Status changes are published as ``opencode`` events. The runtime follows the project and the
model settings on its own: it starts when both a project and a key exist, restarts when
either changes and stops when the project closes or the key is removed.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import subprocess
import sys
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from teststand_backend.mcp_gateway.agent_instructions import AGENT_INSTRUCTIONS
from teststand_backend.util import Record

log = logging.getLogger(__name__)

OPENCODE_VERSION = "1.18.15"
"""The bundled ``opencode-windows-x64-baseline`` version (apps/desktop/package.json)."""
USERNAME = "opencode"
LISTENING = re.compile(rb"opencode server listening on (http://\S+)", re.IGNORECASE)
LOOPBACK = ("127.0.0.1", "localhost", "::1")


class OpenCodeError(RuntimeError):
    """A startup failure whose message is shown to the operator."""


@dataclass(frozen=True)
class LlmChoice:
    """What a running OpenCode was configured with; a change restarts it."""

    base_url: str
    model: str
    api_key: str | None
    api: str = "chat"


PROVIDER = "llm"
"""The one provider OpenCode is given: the user's OpenAI-compatible endpoint."""


def opencode_config(endpoint: str, base_url: str, model: str, api: str = "chat") -> str:
    """``OPENCODE_CONFIG_CONTENT``: secrets stay ``{env:...}`` references.

    ``api`` ``chat`` speaks Chat Completions (``@ai-sdk/openai-compatible``), which DeepSeek,
    Qwen, Kimi, GLM and most gateways offer; ``responses`` uses OpenAI's own provider and the
    Responses API.
    Shell commands and anything outside the project folder need the operator's approval: the
    agent works through the testStand tools, not through testStand's files or the hardware
    drivers directly. Only the primary agents are enabled (see the subagent note below).
    """
    return json.dumps(
        {
            "autoupdate": False,
            "enabled_providers": [PROVIDER],
            "model": f"{PROVIDER}/{model}",
            "small_model": f"{PROVIDER}/{model}",
            "permission": {"bash": "ask", "external_directory": "ask"},
            "default_agent": "build",
            "agent": {
                "build": {"prompt": AGENT_INSTRUCTIONS},
                "plan": {"prompt": AGENT_INSTRUCTIONS},
                # Subagents run in child sessions whose approval requests the sidebar does not
                # show, so a subagent asking to run a command would wait forever.
                "general": {"disable": True},
                "explore": {"disable": True},
            },
            "provider": {
                PROVIDER: {
                    "npm": "@ai-sdk/openai" if api == "responses" else "@ai-sdk/openai-compatible",
                    "name": "LLM",
                    "options": {
                        "baseURL": base_url,
                        "apiKey": "{env:TESTSTAND_LLM_API_KEY}",
                    },
                    "models": {model: {"name": model}},
                }
            },
            "mcp": {
                "teststand": {
                    "type": "remote",
                    "url": endpoint,
                    "headers": {"Authorization": "Bearer {env:TESTSTAND_MCP_TOKEN}"},
                    "enabled": True,
                }
            },
        },
        ensure_ascii=False,
    )


def append_no_proxy(value: str | None) -> str:
    items = [item.strip() for item in (value or "").split(",") if item.strip()]
    for host in LOOPBACK:
        if not any(item.lower() == host for item in items):
            items.append(host)
    return ",".join(items)


def redact(message: str, values: Sequence[str | None]) -> str:
    for value in values:
        if value:
            message = message.replace(value, "<redacted>")
    return message


class OpenCodeRuntime:
    def __init__(
        self,
        command: Sequence[str] | None,
        root: Path,
        *,
        workspace: Callable[[], str | None],
        llm: Callable[[], LlmChoice],
        gateway_endpoint: Callable[[], str],
        gateway_token: Callable[[], str],
        cors_origins: Sequence[str] = (),
        publish: Callable[[Record], object] = lambda _status: None,
        startup_timeout_s: float = 30.0,
        stop_timeout_s: float = 6.0,
    ) -> None:
        """``command`` starts OpenCode (its executable, without ``serve``); ``None`` when the
        main process found no bundled binary."""
        self.command = list(command) if command else None
        self.root = root
        self.workspace = workspace
        self.llm = llm
        self.gateway_endpoint = gateway_endpoint
        self.gateway_token = gateway_token
        self.cors_origins = list(cors_origins)
        self.publish = publish
        self.startup_timeout_s = startup_timeout_s
        self.stop_timeout_s = stop_timeout_s
        self.password = secrets.token_urlsafe(32)
        self._state = "stopped"
        self._message: str | None = None
        self._url: str | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._starting: asyncio.Task[None] | None = None
        self._readers: list[asyncio.Task[None]] = []
        self._background: set[asyncio.Task[Any]] = set()
        self._closed = False

    # -- state ---------------------------------------------------------------------------------

    def status(self) -> Record:
        workspace = self.workspace()
        return {
            "state": self._state,
            "workspaceState": "ready" if workspace else "requires_project",
            "version": OPENCODE_VERSION,
            **({"workspace": workspace} if workspace else {}),
            **({"apiUrl": self._url} if self._url else {}),
            **({"message": self._message} if self._message else {}),
        }

    def connection(self) -> Record | None:
        """``{url, username, password}`` of the running server, for the main process."""
        if self._url is None:
            return None
        return {"url": self._url, "username": USERNAME, "password": self.password}

    def _set(self, state: str, message: str | None = None, url: str | None = None) -> None:
        self._state, self._message, self._url = state, message, url
        self.publish(self.status())

    # -- control -------------------------------------------------------------------------------

    async def start(self) -> Record:
        if self._state == "running" or self._closed:
            return self.status()
        task = self._starting
        if task is None:
            task = self._starting = asyncio.create_task(self._start())
            task.add_done_callback(self._started)
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if not task.cancelled():
                raise
        return self.status()

    async def stop(self) -> Record:
        task = self._starting
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._terminate()
        self._set("stopped")
        return self.status()

    async def restart(self) -> Record:
        await self.stop()
        return await self.start()

    def _started(self, task: asyncio.Task[None]) -> None:
        if self._starting is task:
            self._starting = None

    async def _start(self) -> None:
        self._set("starting")
        try:
            if sys.platform != "win32":
                raise OpenCodeError("内置 OpenCode 当前仅支持 Windows x64。")
            if self.command is None:
                raise OpenCodeError("未找到内置 OpenCode 可执行文件。")
            llm = self.llm()
            if not llm.api_key:
                raise OpenCodeError("请先配置 OpenAI API Key。")
            workspace = self.workspace()
            if not workspace:
                self._set("stopped", "请先打开项目文件夹。")
                return
            process = self._process = await self._spawn(workspace, llm)
            url = await self._wait_for_url(process)
            await self._wait_until_healthy(url, process)
            self._set("running", url=url)
            self._track(self._watch(process))
        except asyncio.CancelledError:
            await self._terminate()
            self._set("stopped")
            raise
        except Exception as error:
            await self._terminate()
            self._set("error", self._safe(str(error) or type(error).__name__))

    async def _spawn(self, workspace: str, llm: LlmChoice) -> asyncio.subprocess.Process:
        assert self.command is not None and llm.api_key
        directories = {name: self.root / name for name in ("data", "config", "state", "cache")}
        for directory in directories.values():
            directory.mkdir(parents=True, exist_ok=True)
        environment = {
            **os.environ,
            "OPENCODE_CLIENT": "teststand",
            "OPENCODE_SERVER_USERNAME": USERNAME,
            "OPENCODE_SERVER_PASSWORD": self.password,
            "OPENCODE_CONFIG_CONTENT": opencode_config(
                self.gateway_endpoint(), llm.base_url, llm.model, llm.api
            ),
            "TESTSTAND_MCP_TOKEN": self.gateway_token(),
            "TESTSTAND_LLM_API_KEY": llm.api_key,
            "XDG_DATA_HOME": str(directories["data"]),
            "XDG_CONFIG_HOME": str(directories["config"]),
            "XDG_STATE_HOME": str(directories["state"]),
            "XDG_CACHE_HOME": str(directories["cache"]),
            # Windows variables are case-insensitive: one entry covers no_proxy too.
            "NO_PROXY": append_no_proxy(os.environ.get("NO_PROXY")),
        }
        arguments = ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "WARN"]
        for origin in self.cors_origins:
            arguments += ["--cors", origin]
        return await asyncio.create_subprocess_exec(
            *self.command,
            *arguments,
            cwd=workspace,
            env=environment,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    async def _wait_for_url(self, process: asyncio.subprocess.Process) -> str:
        """Read both pipes (for the whole life of the process, so they never fill) until the
        listening line appears."""
        found: asyncio.Future[str] = asyncio.get_running_loop().create_future()

        def inspect(line: bytes) -> None:
            match = LISTENING.search(line)
            if match and not found.done():
                found.set_result(match.group(1).decode())

        self._readers = [
            asyncio.create_task(_drain(stream, inspect))
            for stream in (process.stdout, process.stderr)
            if stream is not None
        ]
        exited: asyncio.Future[int] = asyncio.ensure_future(process.wait())
        waiting: set[asyncio.Future[Any]] = {found, exited}
        try:
            done, _ = await asyncio.wait(
                waiting,
                timeout=self.startup_timeout_s,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            exited.cancel()
        if found in done:
            return found.result()
        found.cancel()
        if process.returncode is not None:
            raise OpenCodeError(f"OpenCode 在就绪前退出（code={process.returncode}）。")
        raise OpenCodeError("OpenCode 启动超时，未返回监听地址。")

    async def _wait_until_healthy(self, url: str, process: asyncio.subprocess.Process) -> None:
        deadline = asyncio.get_running_loop().time() + self.startup_timeout_s
        async with httpx.AsyncClient(
            auth=(USERNAME, self.password), timeout=2.0, trust_env=False
        ) as http:
            while asyncio.get_running_loop().time() < deadline:
                if process.returncode is not None:
                    raise OpenCodeError(f"OpenCode 在就绪前退出（code={process.returncode}）。")
                with contextlib.suppress(httpx.HTTPError):
                    if (await http.get(url.rstrip("/") + "/global/health")).is_success:
                        return
                await asyncio.sleep(0.1)
        raise OpenCodeError("OpenCode 健康检查超时。")

    async def _watch(self, process: asyncio.subprocess.Process) -> None:
        code = await process.wait()
        if self._process is process and self._state == "running":
            self._process = None
            self._set("error", f"OpenCode 意外退出（code={code}）。")

    async def _terminate(self) -> None:
        process, self._process = self._process, None
        readers, self._readers = self._readers, []
        if process is not None and process.returncode is None:
            if sys.platform == "win32":
                # The whole tree: OpenCode starts helper processes of its own.
                killer = await asyncio.create_subprocess_exec(
                    "taskkill.exe",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                await killer.wait()
            try:
                await asyncio.wait_for(process.wait(), self.stop_timeout_s)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)

    def _safe(self, message: str) -> str:
        try:
            api_key = self.llm().api_key
        except Exception:
            api_key = None
        token: str | None
        try:
            token = self.gateway_token()
        except Exception:
            token = None
        return redact(message, [token, api_key, self.password])

    # -- following the project and the settings ------------------------------------------------

    async def autostart(self) -> None:
        """At service start: run when a project and a key are already there."""
        if self.workspace() and self._key():
            await self.start()

    async def workspace_changed(self) -> None:
        """The open project changed or closed."""
        if not self.workspace():
            if self._state != "stopped":
                await self.stop()
            return
        if not self._key():
            return
        if self._state in ("running", "starting"):
            await self.restart()
        else:
            await self.start()

    async def settings_changed(self, before: LlmChoice, after: LlmChoice) -> None:
        """The model settings were saved (``before`` and ``after`` that save)."""
        if not after.api_key or not self.workspace():
            if self._state != "stopped":
                await self.stop()
            return
        if not before.api_key:
            await self.start()
            return
        if before == after:
            return
        if self._state in ("running", "starting"):
            await self.restart()
        elif self._state == "error":
            await self.start()

    async def gateway_token_changed(self) -> None:
        """OpenCode reads the gateway token from its environment at startup."""
        if self._state in ("running", "starting"):
            await self.restart()

    def schedule(self, action: Callable[[], Awaitable[object]]) -> None:
        """Run a reconciliation in the background; the caller's operation does not wait."""
        if not self._closed:
            self._track(action())

    def _track(self, awaitable: Awaitable[object]) -> None:
        async def run() -> None:
            try:
                await awaitable
            except Exception:
                log.exception("OpenCode reconciliation failed")

        task = asyncio.create_task(run())
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def close(self) -> None:
        self._closed = True
        for task in list(self._background):
            task.cancel()
        await asyncio.gather(*self._background, return_exceptions=True)
        await self.stop()

    def _key(self) -> str | None:
        try:
            return self.llm().api_key
        except Exception:
            log.exception("The LLM key cannot be read")
            return None


async def _drain(stream: asyncio.StreamReader, inspect: Callable[[bytes], None]) -> None:
    while line := await stream.readline():
        inspect(line)
        log.debug("OpenCode: %s", line.decode(errors="replace").rstrip())
