"""Connecting Codex to the HardwareHarness MCP gateway (Windows).

Codex reads the gateway's bearer token from the user environment variable
``HARDWAREHARNESS_MCP_TOKEN`` and its server entry from ``codex mcp add``. Installing writes
both, verifies them and probes the gateway; any failure restores the previous variable and
``config.toml``. Status compares what Codex has with the running gateway.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

import httpx

from hardwareharness_backend.util import Record

CODEX_TOKEN_ENV = "HARDWAREHARNESS_MCP_TOKEN"
SERVER_NAME = "hardwareharness"
Probe = Callable[[str, str], Awaitable[None]]


class CommandFailed(RuntimeError):
    def __init__(self, message: str, stdout: str = "", stderr: str = "") -> None:
        super().__init__(message)
        self.stdout, self.stderr = stdout, stderr


class CommandRunner(Protocol):
    async def run(self, file: str, args: list[str], timeout_s: float = 15.0) -> str:
        """Standard output; raises :class:`CommandFailed` on a non-zero exit."""
        ...


class UserEnvironment(Protocol):
    async def get(self, name: str) -> str | None: ...
    async def set(self, name: str, value: str) -> None: ...
    async def remove(self, name: str) -> None: ...


class Gateway(Protocol):
    def status(self) -> Record: ...
    def token(self) -> str: ...
    async def rotate_token(self) -> str: ...
    async def replace_token(self, token: str) -> None: ...


class SubprocessRunner:
    async def run(self, file: str, args: list[str], timeout_s: float = 15.0) -> str:
        command = [file, *args]
        if re.search(r"\.(cmd|bat)$", file, re.IGNORECASE):
            command = ["cmd.exe", "/d", "/s", "/c", subprocess.list2cmdline(command)]
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout_s)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
            raise CommandFailed(f"{Path(file).name} timed out") from None
        out = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")
        if process.returncode != 0:
            raise CommandFailed(
                err.strip() or out.strip() or f"exit code {process.returncode}", out, err
            )
        return out


class WindowsUserEnvironment:
    """``HKCU\\Environment``, announced to running programs like ``setx`` does."""

    async def get(self, name: str) -> str | None:
        return await asyncio.to_thread(self._get, name)

    async def set(self, name: str, value: str) -> None:
        await asyncio.to_thread(self._write, name, value)

    async def remove(self, name: str) -> None:
        await asyncio.to_thread(self._write, name, None)

    @staticmethod
    def _get(name: str) -> str | None:
        if sys.platform != "win32":
            raise RuntimeError("User environment variables are only managed on Windows")
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                return str(winreg.QueryValueEx(key, name)[0])
        except FileNotFoundError:
            return None

    @staticmethod
    def _write(name: str, value: str | None) -> None:
        if sys.platform != "win32":
            raise RuntimeError("User environment variables are only managed on Windows")
        import ctypes
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE
        ) as key:
            if value is None:
                with contextlib.suppress(FileNotFoundError):
                    winreg.DeleteValue(key, name)
            else:
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
        result = ctypes.c_size_t()
        # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5 s.
        ctypes.windll.user32.SendMessageTimeoutW(
            0xFFFF, 0x001A, 0, "Environment", 0x0002, 5000, ctypes.byref(result)
        )


class MemoryUserEnvironment:
    """Integration-test mode: end-to-end runs never change the real user environment."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def get(self, name: str) -> str | None:
        return self.values.get(name)

    async def set(self, name: str, value: str) -> None:
        self.values[name] = value

    async def remove(self, name: str) -> None:
        self.values.pop(name, None)


class MemoryCodexRunner:
    """Integration-test mode: a Codex CLI that keeps its one MCP entry in memory."""

    def __init__(self) -> None:
        self.config: Record | None = None

    async def run(self, file: str, args: list[str], timeout_s: float = 15.0) -> str:
        if args[:1] == ["--version"]:
            return "codex-cli e2e\n"
        if args == ["mcp", "get", SERVER_NAME, "--json"]:
            if self.config is None:
                raise CommandFailed("MCP server not found")
            return json.dumps(self.config)
        if args == ["mcp", "remove", SERVER_NAME]:
            self.config = None
            return ""
        if args[:2] == ["mcp", "add"]:
            self.config = {
                "name": SERVER_NAME,
                "enabled": True,
                "transport": {
                    "type": "streamable_http",
                    "url": args[args.index("--url") + 1],
                    "bearer_token_env_var": args[args.index("--bearer-token-env-var") + 1],
                    "http_headers": None,
                },
            }
            return ""
        raise CommandFailed(f"Unexpected Codex command: {' '.join(args)}")


async def probe_gateway(endpoint: str, token: str) -> None:
    """An MCP ``initialize`` with the token, as Codex will send it."""
    async with httpx.AsyncClient(timeout=5.0, trust_env=False) as http:
        response = await http.post(
            endpoint,
            headers={
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {token}",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "hardwareharness-integration-check", "version": "0.1.0"},
                },
            },
        )
    if not response.is_success:
        raise RuntimeError(f"Gateway 连接验证失败（HTTP {response.status_code}）。")


class CodexIntegration:
    def __init__(
        self,
        gateway: Callable[[], Gateway],
        backup_dir: Path,
        *,
        runner: CommandRunner | None = None,
        environment: UserEnvironment | None = None,
        codex_cli: str | None = None,
        codex_home: Path | None = None,
        probe: Probe = probe_gateway,
    ) -> None:
        self._gateway = gateway
        self.backup_dir = backup_dir
        self.runner: CommandRunner = runner or SubprocessRunner()
        self.environment: UserEnvironment = environment or WindowsUserEnvironment()
        self.codex_cli = codex_cli or os.environ.get("HARDWAREHARNESS_CODEX_CLI_PATH")
        self.codex_home = codex_home
        self.probe = probe
        self._cli: Record | None = None

    @property
    def gateway(self) -> Gateway:
        return self._gateway()

    async def status(self) -> Record:
        gateway = self.gateway.status()
        if sys.platform != "win32":
            return self._summary(gateway, "unavailable", "首版自动接入仅支持 Windows。")
        try:
            cli = await self._locate()
            if not cli.get("path"):
                message = "未找到 Codex CLI，请先安装或更新 Codex。"
                return self._summary(gateway, "unavailable", message, cli)
            value, configuration = await asyncio.gather(
                self.environment.get(CODEX_TOKEN_ENV), self._read_config(cli["path"])
            )
            if value is None:
                environment_state = "missing"
            else:
                environment_state = "configured" if value == self.gateway.token() else "mismatch"
            configuration_state = _configuration_state(configuration, gateway["endpoint"])
            if environment_state == "configured" and configuration_state == "configured":
                state = "configured"
            elif environment_state == "missing" and configuration_state == "missing":
                state = "not_installed"
            else:
                state = "misconfigured"
            transport = (configuration or {}).get("transport") or {}
            return {
                **self._summary(gateway, state, _MESSAGES[state], cli),
                "environment": {"name": CODEX_TOKEN_ENV, "state": environment_state},
                "configuration": {
                    "state": configuration_state,
                    **({"endpoint": transport["url"]} if transport.get("url") else {}),
                    **(
                        {"bearerTokenEnvVar": transport["bearer_token_env_var"]}
                        if transport.get("bearer_token_env_var")
                        else {}
                    ),
                },
            }
        except Exception as error:
            return self._summary(gateway, "error", self._safe(error))

    async def preview(self) -> Record:
        status = await self.status()
        missing = status["configuration"]["state"] == "missing"
        return {
            "agent": "codex",
            "endpoint": status["gateway"]["endpoint"],
            "environmentVariable": CODEX_TOKEN_ENV,
            "replacesExisting": not missing,
            "createsBackup": True,
            "requiresAgentRestart": True,
            "actions": [
                f"创建或更新用户环境变量 {CODEX_TOKEN_ENV}",
                f"注册 Codex MCP：{SERVER_NAME}"
                if missing
                else f"替换现有 Codex MCP：{SERVER_NAME}",
                "验证 MCP 地址与 Bearer 令牌环境变量",
                "完成后完全重启 Codex",
            ],
        }

    async def install(self) -> Record:
        gateway = self.gateway.status()
        if not gateway["running"]:
            raise RuntimeError(
                "HardwareHarness MCP Gateway 未运行。请保持 HardwareHarness 打开后重试。"
            )
        cli = await self._require_cli("未找到 Codex CLI，请先安装或更新 Codex。")

        async def apply() -> None:
            await self.environment.set(CODEX_TOKEN_ENV, self.gateway.token())
            if await self._read_config(cli):
                await self._codex(cli, ["mcp", "remove", SERVER_NAME])
            endpoint = gateway["endpoint"]
            await self._codex(
                cli,
                ["mcp", "add", SERVER_NAME, "--url", endpoint]
                + ["--bearer-token-env-var", CODEX_TOKEN_ENV],
            )
            installed = await self._read_config(cli)
            if _configuration_state(installed, endpoint) != "configured":
                raise RuntimeError("Codex CLI 已返回成功，但写入的 MCP 配置未通过验证。")
            await self.probe(endpoint, self.gateway.token())

        await self._transaction(apply)
        return {**await self.status(), "message": "配置已就绪，请完全退出并重新启动 Codex。"}

    async def remove(self) -> Record:
        cli = await self._require_cli("未找到 Codex CLI，无法自动移除配置。")

        async def apply() -> None:
            if await self._read_config(cli):
                await self._codex(cli, ["mcp", "remove", SERVER_NAME])
            await self.environment.remove(CODEX_TOKEN_ENV)

        await self._transaction(apply)
        return {**await self.status(), "message": "已移除 Codex 接入配置。"}

    async def test(self) -> Record:
        status = await self.status()
        if status["state"] != "configured":
            return status
        await self.probe(status["gateway"]["endpoint"], self.gateway.token())
        return {**await self.status(), "message": "HardwareHarness Gateway 与 Codex 配置验证成功。"}

    async def rotate_token(self) -> Record:
        """A new gateway token; a configured Codex gets it too, or both roll back."""
        old_token = self.gateway.token()
        old_value = await self.environment.get(CODEX_TOKEN_ENV)
        configured = (await self.status())["configuration"]["state"] == "configured"
        try:
            token = await self.gateway.rotate_token()
            if configured:
                await self.environment.set(CODEX_TOKEN_ENV, token)
        except Exception as error:
            await self.gateway.replace_token(old_token)
            await self._restore_environment(old_value)
            raise RuntimeError(self._safe(error)) from error
        message = "令牌已轮换，请完全重启 Codex。" if configured else "Gateway 令牌已轮换。"
        return {**await self.status(), "message": message}

    async def _transaction(self, apply: Callable[[], Awaitable[None]]) -> None:
        old_value = await self.environment.get(CODEX_TOKEN_ENV)
        config = self._config_path()
        backup: Path | None = None
        existed = config.exists()
        if existed:
            self.backup_dir.mkdir(parents=True, exist_ok=True)
            backup = self.backup_dir / f"codex-config-{time.time_ns()}.toml"
            shutil.copyfile(config, backup)
        try:
            await apply()
        except Exception as error:
            await self._restore_environment(old_value)
            if backup is not None:
                shutil.copyfile(backup, config)
            elif not existed:
                config.unlink(missing_ok=True)
            raise RuntimeError(self._safe(error)) from error
        finally:
            if backup is not None:
                backup.unlink(missing_ok=True)

    async def _restore_environment(self, value: str | None) -> None:
        if value is None:
            await self.environment.remove(CODEX_TOKEN_ENV)
        else:
            await self.environment.set(CODEX_TOKEN_ENV, value)

    async def _require_cli(self, message: str) -> str:
        cli = await self._locate()
        if not cli.get("path"):
            raise RuntimeError(message)
        return str(cli["path"])

    async def _locate(self) -> Record:
        if self._cli is not None:
            return self._cli
        path = self.codex_cli
        if not path:
            path = await self._where("codex.exe") or await self._where("codex")
        if not path:
            return {"available": False}
        try:
            version = (await self.runner.run(path, ["--version"])).strip()
        except Exception:
            return {"available": False, "path": path}
        self._cli = {"available": True, "path": path, **({"version": version} if version else {})}
        return self._cli

    async def _where(self, name: str) -> str | None:
        try:
            output = await self.runner.run("where.exe", [name])
        except Exception:
            return None
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        runnable = [line for line in lines if re.search(r"\.(exe|cmd|bat)$", line, re.I)]
        return next(iter(runnable or lines), None)

    async def _read_config(self, cli: str) -> Record | None:
        try:
            output = await self._codex(cli, ["mcp", "get", SERVER_NAME, "--json"])
        except Exception as error:
            message = str(error).lower()
            if any(text in message for text in ("not found", "no mcp server", "不存在")):
                return None
            raise
        value = json.loads(output)
        return value if isinstance(value, dict) else None

    async def _codex(self, cli: str, args: list[str]) -> str:
        try:
            return await self.runner.run(cli, args)
        except Exception as error:
            raise RuntimeError(self._safe(error)) from error

    def _config_path(self) -> Path:
        home = self.codex_home or Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        return home / "config.toml"

    def _summary(self, gateway: Record, state: str, message: str, cli: Any = None) -> Record:
        return {
            "agent": "codex",
            "state": state,
            "gateway": {
                "running": gateway["running"],
                "endpoint": gateway["endpoint"],
                "toolCount": gateway["toolCount"],
            },
            "cli": cli or {"available": False},
            "environment": {"name": CODEX_TOKEN_ENV, "state": "missing"},
            "configuration": {"state": "missing"},
            **({"lastClient": gateway["lastClient"]} if gateway.get("lastClient") else {}),
            "message": message,
        }

    def _safe(self, error: BaseException) -> str:
        parts = [str(error), getattr(error, "stderr", ""), getattr(error, "stdout", "")]
        raw = next((part.strip() for part in parts if isinstance(part, str) and part.strip()), "")
        try:
            token = self.gateway.token()
        except Exception:
            token = ""
        message = raw or type(error).__name__
        return message.replace(token, "<redacted>") if token else message


_MESSAGES = {
    "configured": "Codex 配置已就绪。",
    "not_installed": "尚未接入 Codex。",
    "misconfigured": "Codex 接入配置需要修复。",
}


def _configuration_state(config: Record | None, endpoint: str) -> str:
    if not config:
        return "missing"
    transport = config.get("transport") or {}
    headers = transport.get("http_headers") or {}
    authorization = any(str(key).lower() == "authorization" for key in headers)
    matches = (
        config.get("enabled") is not False
        and transport.get("type") == "streamable_http"
        and transport.get("url") == endpoint
        and transport.get("bearer_token_env_var") == CODEX_TOKEN_ENV
        and not authorization
    )
    return "configured" if matches else "mismatch"
