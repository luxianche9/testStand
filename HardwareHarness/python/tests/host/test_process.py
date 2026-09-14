"""The desktop's real child process, using isolated storage and test OS crypto."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio

from hardwareharness_backend.compat import UNDEFINED
from hardwareharness_backend.host.codec import decode, encode


class Client:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process
        self.sequence = 0
        self.state: dict[str, Any] = {}
        self.fail_encryption = False
        self.events: list[dict[str, Any]] = []

    async def call(self, method: str, params: Any = None) -> Any:
        assert self.process.stdin and self.process.stdout
        self.sequence += 1
        identifier = f"test:{self.sequence}"
        self.process.stdin.write(
            (
                json.dumps(
                    {"jsonrpc": "2.0", "id": identifier, "method": method, "params": encode(params)}
                )
                + "\n"
            ).encode()
        )
        await self.process.stdin.drain()
        while True:
            raw = await asyncio.wait_for(self.process.stdout.readline(), 30)
            if not raw:
                assert self.process.stderr
                raise AssertionError((await self.process.stderr.read()).decode())
            message = json.loads(raw)
            if "method" in message:
                if "id" not in message:
                    if message["method"] == "desktop.event":
                        self.events.append(decode(message["params"]))
                    continue
                arguments = decode(message["params"])
                if self.fail_encryption and message["method"] == "host.safeStorage.encrypt":
                    response = {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": encode({"message": "OS encryption failed"}),
                    }
                    self.process.stdin.write((json.dumps(response) + "\n").encode())
                    await self.process.stdin.drain()
                    continue
                if message["method"] == "host.safeStorage.encrypt":
                    result = ("protected:" + arguments["value"]).encode()
                else:
                    result = arguments["value"].decode()[len("protected:") :]
                response = {"jsonrpc": "2.0", "id": message["id"], "result": encode(result)}
                self.process.stdin.write((json.dumps(response) + "\n").encode())
                await self.process.stdin.drain()
                continue
            assert message["id"] == identifier
            self.state = decode(message["state"])
            if "error" in message:
                raise RuntimeError(decode(message["error"])["message"])
            return decode(message["result"])


@pytest_asyncio.fixture
async def client(tmp_path: Path) -> AsyncIterator[Client]:
    async with running_client(tmp_path / "profile") as value:
        yield value


@asynccontextmanager
async def running_client(profile: Path) -> AsyncIterator[Client]:
    executable = os.environ.get("HARDWAREHARNESS_BACKEND_EXECUTABLE")
    command = (
        [executable] if executable else [sys.executable, "-u", "-m", "hardwareharness_backend.host"]
    )
    environment = dict(os.environ)
    if environment.get("HARDWAREHARNESS_BACKEND_ISOLATED_ENV") == "1":
        for key in list(environment):
            if key.startswith(("PYTHON", "UV_")) or key == "VIRTUAL_ENV":
                del environment[key]
        environment["PATH"] = str(Path(os.environ["SYSTEMROOT"]) / "System32")
    process = await asyncio.create_subprocess_exec(
        *command,
        env=environment,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    client = Client(process)
    try:
        await client.call(
            "backend.initialize",
            {
                "userData": str(profile),
                "gatewayPort": 0,
                "locale": "zh-CN",
                "safety": {"cleanupBudgetMs": 15000, "cleanupOperatorTimeoutMs": 3000},
            },
        )
        yield client
        if process.returncode is None:
            await client.call("backend.shutdown")
            assert process.stdin
            process.stdin.close()
            await asyncio.wait_for(process.wait(), 10)
            assert process.returncode == 0
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_real_child_settings_project_and_safe_storage(client: Client, tmp_path: Path) -> None:
    assert client.state["gateway"]["running"]
    dashboard = await client.call(
        "application.system.dashboard", {"args": [{"actor": "human", "source": "desktop"}]}
    )
    assert dashboard["computers"] == []
    assert dashboard["hardware"] == []
    await client.call("settings.update", {"theme": "dark"})
    assert client.state["settings"]["theme"] == "dark"
    project = tmp_path / "中文 project"
    project.mkdir()
    context = {"actor": "human", "source": "desktop"}
    result = await client.call(
        "application.projects.initializeFolder", {"args": [context, str(project)]}
    )
    assert result["file"]["formatVersion"] == 3
    assert client.state["project"]["file"]["projectId"] == result["file"]["projectId"]
    await client.call(
        "settings.saveLlm",
        {"baseUrl": "https://example.com/v1", "model": "m", "apiKey": "key-value"},
    )
    assert client.state["llmApiKey"] == "key-value"
    assert "key-value" not in (tmp_path / "profile/secrets.json").read_text()
    token = await client.call("gateway.rotateToken")
    assert token == client.state["gatewayToken"]
    await client.call("application.projects.leaveProject", {"args": [context]})
    assert "project" not in client.state


async def test_private_dispatch_is_an_allowlist_and_rejects_actor_spoofing(client: Client) -> None:
    with pytest.raises(RuntimeError, match="Unknown backend method"):
        await client.call("application.devices.__dict__", {"args": []})
    with pytest.raises(RuntimeError, match="Desktop request context"):
        await client.call("application.system.dashboard", {"args": [{"actor": "system"}]})


async def test_binary_bundle_and_undefined_image_port(client: Client, tmp_path: Path) -> None:
    context = {"actor": "human", "source": "desktop"}
    await client.call(
        "application.devices.saveHardware",
        {
            "args": [
                context,
                {
                    "formatVersion": 2,
                    "hardwareId": "CARD",
                    "label": "中文卡",
                    "kind": "passive",
                    "ports": [],
                },
            ]
        },
    )
    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452")
    saved = await client.call(
        "application.devices.setHardwareImageBytes",
        {
            "args": [context, "CARD", UNDEFINED, png, ".png"],
        },
    )
    path = await client.call(
        "assets.resolveImagePath",
        {
            "hardwareId": "CARD",
            "assetId": saved["appearanceAssetId"],
        },
    )
    assert Path(path).read_bytes() == png
    exported = await client.call("application.devices.exportBundle", {"args": [context, "CARD"]})
    assert isinstance(exported, bytes) and exported.startswith(b"PK")
    await client.call("application.devices.removeHardware", {"args": [context, "CARD"]})
    imported = await client.call("application.devices.importBundle", {"args": [context, exported]})
    assert imported == {"id": "CARD", "label": "中文卡", "replaced": False}
    assert Path(path).read_bytes() == png


async def test_partial_settings_commit_is_visible_in_failed_response(client: Client) -> None:
    client.fail_encryption = True
    with pytest.raises(RuntimeError, match="OS encryption failed"):
        await client.call(
            "settings.saveLlm",
            {
                "baseUrl": "https://example.com/changed",
                "model": "new-model",
                "apiKey": "secret",
            },
        )
    assert client.state["settings"]["llm"] == {
        "baseUrl": "https://example.com/changed",
        "model": "new-model",
    }
    assert not client.state["llmApiKeyConfigured"]


async def test_killed_child_recovers_run_then_cancels_with_latest_cleanup_context(
    tmp_path: Path,
) -> None:
    profile, project = tmp_path / "profile", tmp_path / "崩溃恢复 project"
    project.mkdir()
    context = {"actor": "human", "source": "desktop"}
    async with running_client(profile) as first:
        document = await first.call(
            "application.projects.initializeFolder", {"args": [context, str(project)]}
        )
        task = document["file"]["task"]
        task["variables"] = [{"name": "x", "type": "number", "defaultValue": 0}]
        task["steps"] = [
            {
                "stepId": f"S{value}",
                "label": "Set",
                "type": "set_variable",
                "enabled": True,
                "variable": "x",
                "value": {"kind": "literal", "value": value},
            }
            for value in (1, 2)
        ] + [
            {
                "stepId": "WAIT",
                "label": "Wait",
                "type": "delay",
                "enabled": True,
                "durationMs": {"kind": "literal", "value": 60000},
            }
        ]
        task["cleanup"] = [
            {
                "stepId": "CLEAN",
                "label": "Cleanup",
                "enabled": True,
                "type": "assert",
                "expression": {
                    "kind": "binary",
                    "operator": "eq",
                    "left": {"kind": "variable", "path": "x"},
                    "right": {"kind": "literal", "value": 2},
                },
                "message": "Checkpoint lost latest variable",
            }
        ]
        await first.call("application.orchestration.updateTask", {"args": [context, task]})
        await first.call("application.projects.saveProject", {"args": [context]})
        detail = await first.call("application.orchestration.startRun", {"args": [context]})
        run_id = detail["run"]["runId"]
        async with asyncio.timeout(10):
            while True:
                logs = list(project.rglob("run.jsonl"))
                records = (
                    [json.loads(line) for line in logs[0].read_text("utf-8").splitlines()]
                    if logs
                    else []
                )
                ready = any(
                    record.get("type") == "execution.snapshot"
                    and record["snapshot"]["workflowContext"].get("x") == 2
                    for record in records
                )
                waiting = any(
                    record.get("type") == "nodeRun.upsert"
                    and record["nodeRun"]["nodeId"] == "WAIT"
                    and record["nodeRun"]["status"] == "running"
                    for record in records
                )
                if ready and waiting:
                    break
                await asyncio.sleep(0.02)
        first.process.kill()
        await first.process.wait()
    async with running_client(profile) as second:
        await second.call("application.projects.openFolder", {"args": [context, str(project)]})
        await second.call("application.orchestration.cancelRun", {"args": [context, run_id]})
        async with asyncio.timeout(10):
            while True:
                detail = await second.call(
                    "application.orchestration.getRun", {"args": [context, run_id]}
                )
                if detail["run"]["status"] == "cancelled":
                    break
                await asyncio.sleep(0.02)
        assert (
            next(node for node in detail["nodeRuns"] if node["nodeId"] == "CLEAN")["status"]
            == "passed"
        )
        assert sum(node["nodeId"] == "S1" for node in detail["nodeRuns"]) == 1
        assert sum(node["nodeId"] == "S2" for node in detail["nodeRuns"]) == 1
        assert "run.recovery_resumed" in [event["type"] for event in detail["events"]]


async def test_mcp_project_changes_notify_desktop_once_with_current_snapshot(
    client: Client, tmp_path: Path
) -> None:
    root = tmp_path / "agent project"
    root.mkdir()
    context = {"actor": "human", "source": "desktop"}
    async with httpx.AsyncClient(
        headers={
            "Authorization": "Bearer " + client.state["gatewayToken"],
            "Accept": "application/json, text/event-stream",
        }
    ) as http:
        endpoint = client.state["gateway"]["endpoint"]
        initialized = await http.post(
            endpoint,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "merge-test", "version": "1"},
                },
            },
        )
        assert initialized.status_code == 200
        http.headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
        for name, args, changed in [
            ("initialize_project", {"rootPath": str(root)}, True),
            ("save_project", {}, False),
            ("open_project", {"rootPath": str(root)}, True),
        ]:
            client.events.clear()
            response = await http.post(
                endpoint,
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": args},
                },
            )
            assert response.status_code == 200 and '"isError":true' not in response.text
            await client.call("application.system.dashboard", {"args": [context]})
            events = [item for item in client.events if item["event"] == "project"]
            assert len(events) == 1
            assert events[0]["workspaceChanged"] is changed
            assert events[0]["payload"]["rootPath"] == str(root)
            assert events[0]["state"]["project"] == events[0]["payload"]
    client.events.clear()
    await client.call("application.projects.leaveProject", {"args": [context]})
    events = [item for item in client.events if item["event"] == "project"]
    assert len(events) == 1 and events[0]["payload"] is None
    assert events[0]["workspaceChanged"] is True and "project" not in events[0]["state"]
