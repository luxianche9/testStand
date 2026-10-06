"""The embedded OpenCode runtime: configuration, process control and following the project."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio

from teststand_backend.host.opencode import (
    OPENCODE_VERSION,
    LlmChoice,
    OpenCodeRuntime,
    append_no_proxy,
    opencode_config,
    redact,
)
from teststand_backend.mcp_gateway.agent_instructions import AGENT_INSTRUCTIONS

ROOT = Path(__file__).resolve().parents[3]
BUNDLED = ROOT / "apps/desktop/node_modules/opencode-windows-x64-baseline/bin/opencode.exe"
FAKE_SERVER = """
import base64, json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

mode = os.environ.get("FAKE_OPENCODE_MODE", "serve")
if mode == "exit":
    sys.exit(3)
if mode == "silent":
    import time
    time.sleep(120)
names = ["OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG_CONTENT",
         "TESTSTAND_MCP_TOKEN", "TESTSTAND_LLM_API_KEY", "XDG_DATA_HOME", "NO_PROXY"]
with open(os.environ["FAKE_OPENCODE_RECORD"], "w", encoding="utf-8") as record:
    json.dump({"argv": sys.argv[1:], "cwd": os.getcwd(),
               "env": {name: os.environ.get(name) for name in names}}, record)
secret = "opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]
expected = "Basic " + base64.b64encode(secret.encode()).decode()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path == "/global/health" and self.headers.get("Authorization") == expected
        self.send_response(200 if ok else 401)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass

server = HTTPServer(("127.0.0.1", 0), Handler)
print("opencode server listening on http://127.0.0.1:%d" % server.server_address[1], flush=True)
server.serve_forever()
"""


class Fixture:
    def __init__(self, tmp_path: Path) -> None:
        self.workspace: str | None = str(tmp_path / "project")
        self.llm = LlmChoice("https://llm.example.test/v1", "test-model", "llm-secret")
        self.events: list[dict[str, Any]] = []
        self.record = tmp_path / "record.json"
        script = tmp_path / "fake_opencode.py"
        script.write_text(FAKE_SERVER, encoding="utf-8")
        (tmp_path / "project").mkdir()
        self.runtime = OpenCodeRuntime(
            [sys.executable, str(script)],
            tmp_path / "opencode",
            workspace=lambda: self.workspace,
            llm=lambda: self.llm,
            gateway_endpoint=lambda: "http://127.0.0.1:18080/mcp",
            gateway_token=lambda: "gateway-secret",
            cors_origins=["null", "http://localhost:5173"],
            publish=self.events.append,
            startup_timeout_s=15,
        )

    def recorded(self) -> dict[str, Any]:
        value: dict[str, Any] = json.loads(self.record.read_text("utf-8"))
        return value


@pytest_asyncio.fixture
async def fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Fixture]:
    value = Fixture(tmp_path)
    monkeypatch.setenv("FAKE_OPENCODE_RECORD", str(value.record))
    try:
        yield value
    finally:
        await value.runtime.close()


def test_config_names_the_secrets_and_gives_both_agents_the_instructions() -> None:
    config = json.loads(opencode_config("http://127.0.0.1:8000/mcp", "https://llm/v1", "m"))
    assert config["default_agent"] == "build"
    assert config["agent"]["build"]["prompt"] == AGENT_INSTRUCTIONS
    assert config["agent"]["plan"]["prompt"] == AGENT_INSTRUCTIONS
    assert config["provider"]["llm"]["npm"] == "@ai-sdk/openai-compatible"
    assert config["permission"] == {"bash": "ask", "external_directory": "ask"}
    assert config["provider"]["llm"]["options"] == {
        "baseURL": "https://llm/v1",
        "apiKey": "{env:TESTSTAND_LLM_API_KEY}",
    }
    assert config["model"] == config["small_model"] == "llm/m"
    assert config["mcp"]["teststand"] == {
        "type": "remote",
        "url": "http://127.0.0.1:8000/mcp",
        "headers": {"Authorization": "Bearer {env:TESTSTAND_MCP_TOKEN}"},
        "enabled": True,
    }


def test_helpers() -> None:
    assert append_no_proxy("corp.example, LOCALHOST") == "corp.example,LOCALHOST,127.0.0.1,::1"
    assert append_no_proxy(None) == "127.0.0.1,localhost,::1"
    assert redact("a secret b", ["secret", None, ""]) == "a <redacted> b"


def test_the_version_matches_the_bundled_package() -> None:
    package = json.loads((ROOT / "apps/desktop/package.json").read_text("utf-8"))
    assert package["dependencies"]["opencode-windows-x64-baseline"] == OPENCODE_VERSION


@pytest.mark.skipif(sys.platform != "win32", reason="OpenCode is bundled for Windows only")
async def test_starts_in_the_project_with_isolated_storage_and_secrets_in_the_environment(
    fixture: Fixture,
) -> None:
    runtime = fixture.runtime
    status = await runtime.start()
    assert status["state"] == "running" and status["workspaceState"] == "ready"
    assert status["workspace"] == fixture.workspace and status["version"] == OPENCODE_VERSION
    connection = runtime.connection()
    assert connection is not None and connection["url"] == status["apiUrl"]
    assert connection["username"] == "opencode" and connection["password"] == runtime.password
    assert await runtime.start() == status  # Already running.
    recorded = fixture.recorded()
    assert Path(recorded["cwd"]) == Path(str(fixture.workspace))
    assert recorded["argv"][:2] == ["serve", "--hostname"]
    assert recorded["argv"][-4:] == ["--cors", "null", "--cors", "http://localhost:5173"]
    env = recorded["env"]
    assert env["OPENCODE_SERVER_PASSWORD"] == runtime.password
    assert env["TESTSTAND_MCP_TOKEN"] == "gateway-secret"
    assert env["TESTSTAND_LLM_API_KEY"] == "llm-secret"
    assert "llm-secret" not in env["OPENCODE_CONFIG_CONTENT"]
    assert "127.0.0.1" in env["NO_PROXY"]
    assert Path(env["XDG_DATA_HOME"]).parts[-2:] == ("opencode", "data")
    assert [event["state"] for event in fixture.events] == ["starting", "running"]
    stopped = await runtime.stop()
    assert stopped["state"] == "stopped" and "apiUrl" not in stopped
    assert runtime.connection() is None


@pytest.mark.skipif(sys.platform != "win32", reason="OpenCode is bundled for Windows only")
async def test_reports_an_unexpected_exit(fixture: Fixture) -> None:
    runtime = fixture.runtime
    await runtime.start()
    process = runtime._process
    assert process is not None
    process.kill()
    for _ in range(100):
        if runtime.status()["state"] == "error":
            break
        await asyncio.sleep(0.05)
    assert runtime.status()["state"] == "error"
    assert "意外退出" in runtime.status()["message"]


@pytest.mark.skipif(sys.platform != "win32", reason="OpenCode is bundled for Windows only")
async def test_startup_failures_become_an_error_state(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = fixture.runtime
    monkeypatch.setenv("FAKE_OPENCODE_MODE", "exit")
    status = await runtime.start()
    assert status["state"] == "error" and "就绪前退出" in status["message"]
    monkeypatch.setenv("FAKE_OPENCODE_MODE", "silent")
    runtime.startup_timeout_s = 0.5
    status = await runtime.start()
    assert status["state"] == "error" and "超时" in status["message"]
    fixture.llm = LlmChoice("https://llm.example.test/v1", "test-model", None)
    assert "API Key" in (await runtime.start())["message"]
    runtime.command = None
    assert "未找到" in (await runtime.start())["message"]


@pytest.mark.skipif(sys.platform != "win32", reason="OpenCode is bundled for Windows only")
async def test_can_be_stopped_while_starting(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_OPENCODE_MODE", "silent")
    runtime = fixture.runtime
    starting = asyncio.create_task(runtime.start())
    while runtime._process is None:
        await asyncio.sleep(0.02)
    process = runtime._process
    assert (await runtime.stop())["state"] == "stopped"
    assert (await starting)["state"] == "stopped"
    assert process.returncode is not None


async def test_does_not_start_without_a_project(fixture: Fixture) -> None:
    fixture.workspace = None
    status = await fixture.runtime.start()
    assert status["state"] == "stopped" and status["workspaceState"] == "requires_project"
    assert status["message"] == "请先打开项目文件夹。"
    assert not fixture.record.exists()


class Recording(OpenCodeRuntime):
    """Records what the reconciliation asks for instead of starting processes."""

    def __init__(self, workspace: str | None, key: str | None, state: str = "stopped") -> None:
        super().__init__(
            None,
            Path("unused"),
            workspace=lambda: workspace,
            llm=lambda: LlmChoice("u", "m", key),
            gateway_endpoint=lambda: "",
            gateway_token=lambda: "",
        )
        self._state = state
        self.actions: list[str] = []

    async def start(self) -> dict[str, Any]:
        self.actions.append("start")
        return {}

    async def stop(self) -> dict[str, Any]:
        self.actions.append("stop")
        return {}

    async def restart(self) -> dict[str, Any]:
        self.actions.append("restart")
        return {}


KEY = LlmChoice("u", "m", "key")


@pytest.mark.parametrize(
    ("workspace", "key", "state", "expected"),
    [
        ("P", "key", "stopped", ["start"]),
        ("P", None, "stopped", []),
        (None, "key", "stopped", []),
    ],
)
async def test_autostart(
    workspace: str | None, key: str | None, state: str, expected: list[str]
) -> None:
    runtime = Recording(workspace, key, state)
    await runtime.autostart()
    assert runtime.actions == expected


@pytest.mark.parametrize(
    ("workspace", "key", "state", "expected"),
    [
        (None, "key", "running", ["stop"]),
        (None, "key", "stopped", []),
        ("P", None, "stopped", []),
        ("P", "key", "running", ["restart"]),
        ("P", "key", "stopped", ["start"]),
        ("P", "key", "error", ["start"]),
    ],
)
async def test_follows_the_project(
    workspace: str | None, key: str | None, state: str, expected: list[str]
) -> None:
    runtime = Recording(workspace, key, state)
    await runtime.workspace_changed()
    assert runtime.actions == expected


@pytest.mark.parametrize(
    ("before", "after", "workspace", "state", "expected"),
    [
        (KEY, LlmChoice("u", "m", None), "P", "running", ["stop"]),
        (KEY, LlmChoice("u", "m", None), "P", "stopped", []),
        (KEY, KEY, None, "running", ["stop"]),
        (LlmChoice("u", "m", None), KEY, "P", "stopped", ["start"]),
        (KEY, KEY, "P", "running", []),
        (KEY, LlmChoice("u", "other", "key"), "P", "running", ["restart"]),
        (KEY, LlmChoice("u", "other", "key"), "P", "error", ["start"]),
        (KEY, LlmChoice("u", "other", "key"), "P", "stopped", []),
    ],
)
async def test_follows_the_model_settings(
    before: LlmChoice, after: LlmChoice, workspace: str | None, state: str, expected: list[str]
) -> None:
    runtime = Recording(workspace, after.api_key, state)
    await runtime.settings_changed(before, after)
    assert runtime.actions == expected


async def test_restarts_for_a_new_gateway_token_and_runs_reconciliations_in_the_background() -> (
    None
):
    runtime = Recording("P", "key", "running")
    runtime.schedule(runtime.gateway_token_changed)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert runtime.actions == ["restart"]

    async def failing() -> None:
        raise RuntimeError("boom")

    runtime.schedule(failing)  # Logged, never raised into the caller.
    await asyncio.sleep(0)
    await OpenCodeRuntime.close(runtime)
    runtime.schedule(runtime.gateway_token_changed)
    assert runtime.actions == ["restart", "stop"]


def test_an_unreadable_key_counts_as_none() -> None:
    def broken() -> LlmChoice:
        raise RuntimeError("keyring locked")

    runtime = OpenCodeRuntime(
        None,
        Path("unused"),
        workspace=lambda: "P",
        llm=broken,
        gateway_endpoint=lambda: "",
        gateway_token=lambda: "",
    )
    assert runtime._key() is None
    assert runtime._safe("keyring locked") == "keyring locked"


def _bundled_environment(root: Path) -> dict[str, str]:
    environment = {
        **os.environ,
        "XDG_DATA_HOME": str(root / "data"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_STATE_HOME": str(root / "state"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "OPENCODE_CONFIG_CONTENT": opencode_config(
            "http://127.0.0.1:1/mcp", "http://127.0.0.1:1/v1", "contract-test"
        ),
        "TESTSTAND_MCP_TOKEN": "contract-test-placeholder",
        "TESTSTAND_LLM_API_KEY": "contract-test-placeholder",
    }
    environment.pop("OPENCODE_CONFIG", None)
    environment.pop("OPENCODE_CONFIG_DIR", None)
    return environment


@pytest.mark.skipif(not BUNDLED.is_file(), reason="the bundled OpenCode is not installed")
def test_the_bundled_opencode_resolves_the_agent_instructions(tmp_path: Path) -> None:
    """The exact bundled executable parses the configuration; no model request is made."""
    options: dict[str, Any] = {
        "cwd": tmp_path,
        "env": _bundled_environment(tmp_path),
        "capture_output": True,
        "timeout": 60,
        "check": True,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
    }
    config = json.loads(
        subprocess.run([str(BUNDLED), "--pure", "debug", "config"], **options).stdout
    )
    assert config["default_agent"] == "build"
    assert config["agent"]["build"]["prompt"] == AGENT_INSTRUCTIONS
    assert config["agent"]["plan"]["prompt"] == AGENT_INSTRUCTIONS
    agent = json.loads(
        subprocess.run([str(BUNDLED), "--pure", "debug", "agent", "build"], **options).stdout
    )
    assert agent["mode"] == "primary" and agent["prompt"] == AGENT_INSTRUCTIONS


@pytest.mark.skipif(not BUNDLED.is_file(), reason="the bundled OpenCode is not installed")
async def test_the_bundled_opencode_starts_and_stops(tmp_path: Path) -> None:
    project = tmp_path / "项目 project"
    project.mkdir()
    runtime = OpenCodeRuntime(
        [str(BUNDLED)],
        tmp_path / "opencode",
        workspace=lambda: str(project),
        llm=lambda: LlmChoice("http://127.0.0.1:1/v1", "contract-test", "placeholder"),
        gateway_endpoint=lambda: "http://127.0.0.1:1/mcp",
        gateway_token=lambda: "placeholder",
        startup_timeout_s=60,
    )
    try:
        status = await runtime.start()
        assert status["state"] == "running", status
        assert status["apiUrl"].startswith("http://127.0.0.1:")
    finally:
        await runtime.close()
    assert runtime.status()["state"] == "stopped"
