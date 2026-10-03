"""Connecting Codex to the gateway: status, install with rollback, removal and token rotation."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.host.codex import (
    CODEX_TOKEN_ENV,
    CodexIntegration,
    CommandFailed,
    MemoryCodexRunner,
    MemoryUserEnvironment,
    SubprocessRunner,
)

ENDPOINT = "http://127.0.0.1:18080/mcp"
pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Codex integration is Windows-only")


class FakeCodex:
    def __init__(self, config_path: Path) -> None:
        self.config_path = config_path
        self.calls: list[list[str]] = []
        self.config: dict[str, Any] | None = None
        self.fail_add = False

    async def run(self, file: str, args: list[str], timeout_s: float = 15.0) -> str:
        self.calls.append(args)
        if args == ["--version"]:
            return "codex-cli 1.0.0\n"
        if args == ["mcp", "get", "hardwareharness", "--json"]:
            if self.config is None:
                raise CommandFailed("MCP server not found")
            return json.dumps(self.config)
        if args == ["mcp", "remove", "hardwareharness"]:
            self.config = None
            self.config_path.write_text("removed", encoding="utf-8")
            return ""
        if args[:2] == ["mcp", "add"]:
            if self.fail_add:
                raise CommandFailed("simulated add failure with gateway-token")
            self.config = transport(args[args.index("--url") + 1], args[-1])
            self.config_path.write_text("installed", encoding="utf-8")
            return ""
        raise CommandFailed(f"Unexpected command: {args}")


class FakeGateway:
    def __init__(self) -> None:
        self.current = "gateway-token"
        self.running = True

    def status(self) -> dict[str, Any]:
        return {"running": self.running, "endpoint": ENDPOINT, "toolCount": 40}

    def token(self) -> str:
        return self.current

    async def rotate_token(self) -> str:
        self.current = "rotated-token"
        return self.current

    async def replace_token(self, token: str) -> None:
        self.current = token


def transport(url: str, variable: str) -> dict[str, Any]:
    return {
        "enabled": True,
        "transport": {
            "type": "streamable_http",
            "url": url,
            "bearer_token_env_var": variable,
            "http_headers": None,
        },
    }


class Setup:
    def __init__(self, tmp_path: Path) -> None:
        self.home = tmp_path / ".codex"
        self.home.mkdir()
        self.config = self.home / "config.toml"
        self.codex = FakeCodex(self.config)
        self.environment = MemoryUserEnvironment()
        self.gateway = FakeGateway()
        self.probes: list[tuple[str, str]] = []

        async def probe(endpoint: str, token: str) -> None:
            self.probes.append((endpoint, token))

        self.service = CodexIntegration(
            lambda: self.gateway,
            tmp_path / "backups",
            runner=self.codex,
            environment=self.environment,
            codex_cli="C:\\Codex\\codex.exe",
            codex_home=self.home,
            probe=probe,
        )


@pytest.fixture
def setup(tmp_path: Path) -> Setup:
    return Setup(tmp_path)


async def test_a_clean_machine_is_not_installed(setup: Setup) -> None:
    status = await setup.service.status()
    assert status["state"] == "not_installed"
    assert status["cli"] == {
        "available": True,
        "path": "C:\\Codex\\codex.exe",
        "version": "codex-cli 1.0.0",
    }
    assert status["environment"]["state"] == status["configuration"]["state"] == "missing"


async def test_the_token_value_as_variable_name_is_misconfigured(setup: Setup) -> None:
    setup.codex.config = transport(ENDPOINT, "raw-token")
    status = await setup.service.status()
    assert status["state"] == "misconfigured"
    assert status["configuration"] == {
        "state": "mismatch",
        "endpoint": ENDPOINT,
        "bearerTokenEnvVar": "raw-token",
    }
    await setup.environment.set(CODEX_TOKEN_ENV, "other")
    assert (await setup.service.status())["environment"]["state"] == "mismatch"


async def test_install_replaces_an_entry_and_sets_the_user_token(setup: Setup) -> None:
    setup.config.write_text("original", encoding="utf-8")
    setup.codex.config = transport("http://wrong/mcp", "WRONG")
    preview = await setup.service.preview()
    assert preview["replacesExisting"] is True and "替换" in preview["actions"][1]
    result = await setup.service.install()
    assert result["state"] == "configured"
    assert setup.environment.values[CODEX_TOKEN_ENV] == "gateway-token"
    assert ["mcp", "remove", "hardwareharness"] in setup.codex.calls
    assert [
        "mcp",
        "add",
        "hardwareharness",
        "--url",
        ENDPOINT,
        "--bearer-token-env-var",
        CODEX_TOKEN_ENV,
    ] in setup.codex.calls
    assert setup.probes == [(ENDPOINT, "gateway-token")]
    assert (await setup.service.test())["message"].startswith("HardwareHarness Gateway")
    assert not any((setup.home.parent / "backups").glob("*"))


async def test_a_failed_install_restores_the_environment_and_config(setup: Setup) -> None:
    setup.config.write_text("original-config", encoding="utf-8")
    await setup.environment.set(CODEX_TOKEN_ENV, "previous-token")
    setup.codex.config = transport("http://wrong/mcp", "WRONG")
    setup.codex.fail_add = True
    with pytest.raises(RuntimeError, match="simulated add failure with <redacted>"):
        await setup.service.install()
    assert setup.environment.values[CODEX_TOKEN_ENV] == "previous-token"
    assert setup.config.read_text("utf-8") == "original-config"


async def test_install_needs_the_running_gateway(setup: Setup) -> None:
    setup.gateway.running = False
    with pytest.raises(RuntimeError, match="Gateway 未运行"):
        await setup.service.install()


async def test_remove_and_test_an_unconfigured_codex(setup: Setup) -> None:
    setup.codex.config = transport(ENDPOINT, CODEX_TOKEN_ENV)
    await setup.environment.set(CODEX_TOKEN_ENV, "gateway-token")
    assert (await setup.service.status())["state"] == "configured"
    removed = await setup.service.remove()
    assert removed["state"] == "not_installed" and CODEX_TOKEN_ENV not in setup.environment.values
    assert (await setup.service.test())["state"] == "not_installed"
    assert setup.probes == []


async def test_rotation_keeps_the_gateway_and_codex_in_step(setup: Setup) -> None:
    setup.codex.config = transport(ENDPOINT, CODEX_TOKEN_ENV)
    await setup.environment.set(CODEX_TOKEN_ENV, "gateway-token")
    result = await setup.service.rotate_token()
    assert result["state"] == "configured" and "重启 Codex" in result["message"]
    assert setup.gateway.current == setup.environment.values[CODEX_TOKEN_ENV] == "rotated-token"


async def test_a_failed_rotation_rolls_both_back(setup: Setup) -> None:
    setup.codex.config = transport(ENDPOINT, CODEX_TOKEN_ENV)
    await setup.environment.set(CODEX_TOKEN_ENV, "gateway-token")

    original = setup.environment.set
    failures = [OSError("registry locked")]

    async def flaky(name: str, value: str) -> None:
        if failures:
            raise failures.pop()
        await original(name, value)

    setup.environment.set = flaky  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="registry locked"):
        await setup.service.rotate_token()
    assert setup.gateway.current == setup.environment.values[CODEX_TOKEN_ENV] == "gateway-token"


async def test_a_missing_cli_is_unavailable(tmp_path: Path) -> None:
    class NoCodex:
        async def run(self, file: str, args: list[str], timeout_s: float = 15.0) -> str:
            raise CommandFailed("INFO: Could not find files")

    service = CodexIntegration(
        FakeGateway,
        tmp_path,
        runner=NoCodex(),
        environment=MemoryUserEnvironment(),
        codex_home=tmp_path,
    )
    service.codex_cli = None
    assert (await service.status())["state"] == "unavailable"
    with pytest.raises(RuntimeError, match="未找到 Codex CLI"):
        await service.remove()


async def test_where_prefers_a_runnable_file(tmp_path: Path) -> None:
    class Where:
        async def run(self, file: str, args: list[str], timeout_s: float = 15.0) -> str:
            if file == "where.exe":
                return "C:\\bin\\codex\r\nC:\\bin\\codex.cmd\r\n"
            raise CommandFailed("broken")

    service = CodexIntegration(FakeGateway, tmp_path, runner=Where(), codex_home=tmp_path)
    service.codex_cli = None
    assert await service._locate() == {"available": False, "path": "C:\\bin\\codex.cmd"}


async def test_the_memory_codex_used_by_integration_test_mode() -> None:
    runner = MemoryCodexRunner()
    assert (await runner.run("codex", ["--version"])).startswith("codex-cli")
    with pytest.raises(CommandFailed, match="not found"):
        await runner.run("codex", ["mcp", "get", "hardwareharness", "--json"])
    await runner.run(
        "codex", ["mcp", "add", "hardwareharness", "--url", ENDPOINT, "--bearer-token-env-var", "V"]
    )
    assert (
        json.loads(await runner.run("codex", ["mcp", "get", "hardwareharness", "--json"]))[
            "transport"
        ]["url"]
        == ENDPOINT
    )
    await runner.run("codex", ["mcp", "remove", "hardwareharness"])
    assert runner.config is None
    with pytest.raises(CommandFailed, match="Unexpected"):
        await runner.run("codex", ["other"])


async def test_the_subprocess_runner() -> None:
    runner = SubprocessRunner()
    assert (await runner.run(sys.executable, ["-c", "print('ok')"])).strip() == "ok"
    with pytest.raises(CommandFailed, match="bad") as failed:
        await runner.run(sys.executable, ["-c", "import sys; sys.exit('bad')"])
    assert failed.value.stderr.strip() == "bad"
    with pytest.raises(CommandFailed, match="timed out"):
        await runner.run(sys.executable, ["-c", "import time; time.sleep(5)"], timeout_s=0.2)
