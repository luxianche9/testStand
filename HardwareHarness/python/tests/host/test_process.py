"""The desktop's real service process, with isolated storage and the file secret backend."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio

from hardwareharness_backend.host.runtime import TEST_SECRETS_FILE


class OperationFailed(RuntimeError):
    def __init__(self, status: int, error: dict[str, Any]) -> None:
        super().__init__(error["message"])
        self.status = status
        self.error = error


class Client:
    """Plays the main process (host token) and the renderer (renderer token) over HTTP, and
    follows the SSE stream from the first event."""

    def __init__(self, process: asyncio.subprocess.Process, handshake: dict[str, Any]) -> None:
        self.process = process
        self.handshake = handshake
        self.url = f"http://127.0.0.1:{handshake['port']}"
        self.events: list[tuple[int, str, Any]] = []
        self._changed = asyncio.Event()
        self._reader = asyncio.create_task(self._follow())

    async def invoke(self, operation: str, body: dict[str, Any] | None = None) -> Any:
        """One renderer operation, as the preload sends it."""
        return await self._post(self.handshake["token"], operation, body)

    async def host(self, operation: str, body: dict[str, Any] | None = None) -> Any:
        """One main-process operation."""
        return await self._post(self.handshake["hostToken"], operation, body)

    async def state(self) -> dict[str, Any]:
        result: dict[str, Any] = await self.host("desktop.state")
        return result

    async def wait_for(
        self, predicate: Callable[[tuple[int, str, Any]], bool], count: int = 1
    ) -> list[tuple[int, str, Any]]:
        async def matching() -> list[tuple[int, str, Any]]:
            while True:
                found = [item for item in self.events if predicate(item)]
                if len(found) >= count:
                    return found
                self._changed.clear()
                await self._changed.wait()

        return await asyncio.wait_for(matching(), 10)

    async def close(self) -> None:
        self._reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._reader

    async def _post(self, token: str, operation: str, body: dict[str, Any] | None) -> Any:
        async with httpx.AsyncClient(timeout=30) as http:
            response = await http.post(
                f"{self.url}/api/ops/{operation}",
                headers={"Authorization": "Bearer " + token},
                json=body or {},
            )
        if response.status_code != 200:
            raise OperationFailed(response.status_code, response.json()["error"])
        return response.json()

    async def _follow(self) -> None:
        params = {"token": self.handshake["token"], "after": "0"}
        async with (
            httpx.AsyncClient(timeout=None) as http,
            http.stream("GET", self.url + "/api/events", params=params) as response,
        ):
            fields: dict[str, str] = {}
            async for line in response.aiter_lines():
                if line:
                    key, _, value = line.partition(": ")
                    fields[key] = value
                    continue
                if "event" in fields:
                    item = (int(fields["id"]), fields["event"], json.loads(fields["data"]))
                    self.events.append(item)
                    self._changed.set()
                fields = {}


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
    environment["HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE"] = "1"
    process = await asyncio.create_subprocess_exec(
        *command,
        "--user-data",
        str(profile),
        "--gateway-port",
        "0",
        env=environment,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    client: Client | None = None
    try:
        assert process.stdout and process.stdin
        line = await asyncio.wait_for(process.stdout.readline(), 60)
        if not line:
            assert process.stderr
            raise AssertionError((await process.stderr.read()).decode())
        handshake = json.loads(line)
        assert set(handshake) == {"port", "token", "hostToken", "version"}
        client = Client(process, handshake)
        yield client
        # Closing stdin is the shutdown signal: devices go to their safe state, then exit.
        process.stdin.close()
        await asyncio.wait_for(process.wait(), 15)
        assert process.returncode == 0
    finally:
        if client is not None:
            await client.close()
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_real_child_settings_project_and_credentials(client: Client, tmp_path: Path) -> None:
    assert (await client.state())["gateway"]["running"]
    dashboard = await client.invoke("system.dashboard")
    assert dashboard["computers"] == []
    assert dashboard["hardware"] == []
    await client.host("desktop.updateSettings", {"patch": {"theme": "dark"}})
    assert (await client.state())["settings"]["theme"] == "dark"
    await client.wait_for(lambda item: item[1] == "state" and item[2]["reason"] == "settings")
    project = tmp_path / "中文 project"
    project.mkdir()
    result = await client.invoke("projects.initializeFolder", {"rootPath": str(project)})
    assert result["file"]["formatVersion"] == 4
    assert (await client.state())["project"]["file"]["projectId"] == result["file"]["projectId"]
    saved = await client.host(
        "desktop.saveLlm",
        {"baseUrl": "https://example.com/v1", "model": "m", "apiKey": "key-value"},
    )
    assert saved["apiKeyConfigured"] is True
    assert (await client.state())["llmApiKey"] == "key-value"
    profile = tmp_path / "profile"
    assert not (profile / "secrets.json").exists()
    assert "key-value" not in (profile / "secret-keys.json").read_text("utf-8")
    token = await client.host("desktop.rotateGatewayToken")
    assert token == (await client.state())["gatewayToken"]
    await client.invoke("projects.leaveProject")
    assert "project" not in await client.state()
    audit = [json.loads(line) for line in (profile / "audit.jsonl").read_text("utf-8").splitlines()]
    llm = next(record for record in audit if record["operation"] == "desktop.saveLlm")
    assert llm["arguments"]["api_key"] == "[REDACTED]"
    assert all(record["operation"] != "desktop.state" for record in audit)


async def test_local_api_is_an_allowlist_behind_two_tokens(client: Client) -> None:
    with pytest.raises(OperationFailed, match="Unknown operation") as unknown:
        await client.invoke("devices.__dict__")
    assert unknown.value.status == 404
    with pytest.raises(OperationFailed, match="Invalid request") as invalid:
        await client.invoke("system.dashboard", {"actor": "system"})
    assert invalid.value.status == 400
    with pytest.raises(OperationFailed, match="reserved for the main process") as reserved:
        await client.invoke("desktop.state")
    assert reserved.value.status == 403
    url = client.url + "/api/ops/system.dashboard"
    async with httpx.AsyncClient(timeout=10) as http:
        assert (await http.post(url, json={})).status_code == 401
        wrong = {"Authorization": "Bearer wrong"}
        assert (await http.post(url, json={}, headers=wrong)).status_code == 401
        token = client.handshake["token"]
        rebound = {"Authorization": "Bearer " + token, "Host": "evil.test"}
        assert (await http.post(url, json={}, headers=rebound)).status_code == 421
        document = await http.get(
            client.url + "/api/openapi.json", headers={"Authorization": "Bearer " + token}
        )
    paths = document.json()["paths"]
    assert paths["/api/ops/manual.invokeTool"]["post"]["x-risk"] == "actuate"
    assert "/api/ops/desktop.state" in paths


async def test_events_stream_over_sse_and_resume_after_the_last_id(
    client: Client, tmp_path: Path
) -> None:
    project = tmp_path / "sse project"
    project.mkdir()
    await client.invoke("projects.initializeFolder", {"rootPath": str(project)})
    [first] = await client.wait_for(lambda item: item[1] == "project")
    # Events carry the resource key and version, not the document (design §9.4).
    assert isinstance(first[2]["projectId"], str) and "file" not in first[2]
    await client.invoke("projects.leaveProject")
    events = await client.wait_for(lambda item: item[1] == "project", 2)
    assert events[1][0] > first[0] and events[1][2] == {"projectId": None}
    received: list[tuple[int, str, Any]] = []
    async with (
        httpx.AsyncClient(timeout=30) as http,
        http.stream(
            "GET",
            client.url + "/api/events",
            headers={"Authorization": "Bearer " + client.handshake["token"]},
            params={"after": str(first[0])},
        ) as response,
    ):
        assert response.headers["content-type"].startswith("text/event-stream")
        fields: dict[str, str] = {}
        async for line in response.aiter_lines():
            if line:
                key, _, value = line.partition(": ")
                fields[key] = value
                continue
            if fields.get("event") == "project":
                received.append((int(fields["id"]), "project", json.loads(fields["data"])))
                break
            fields = {}
    assert received == [events[1]]


async def test_binary_bundle_and_omitted_image_port(client: Client) -> None:
    await client.invoke(
        "devices.saveHardware",
        {
            "input": {
                "formatVersion": 2,
                "hardwareId": "CARD",
                "label": "中文卡",
                "kind": "passive",
                "ports": [],
            }
        },
    )
    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452")
    saved = await client.invoke(
        "devices.setHardwareImageBytes",
        {"hardwareId": "CARD", "data": base64.b64encode(png).decode(), "extensionHint": ".png"},
    )
    path = await client.host(
        "desktop.resolveImagePath",
        {"hardwareId": "CARD", "assetId": saved["appearanceAssetId"]},
    )
    assert Path(path).read_bytes() == png
    exported = base64.b64decode(await client.invoke("devices.exportBundle", {"hardwareId": "CARD"}))
    assert exported.startswith(b"PK")
    await client.invoke("devices.removeHardware", {"hardwareId": "CARD"})
    imported = await client.invoke(
        "devices.importBundle", {"data": base64.b64encode(exported).decode()}
    )
    assert imported == {"id": "CARD", "label": "中文卡", "replaced": False}
    assert Path(path).read_bytes() == png


async def test_partial_settings_commit_is_visible_after_a_failed_save(
    client: Client, tmp_path: Path
) -> None:
    secrets = tmp_path / "profile" / TEST_SECRETS_FILE
    secrets.unlink()
    secrets.mkdir()  # The next credential write fails.
    with pytest.raises(OperationFailed):
        await client.host(
            "desktop.saveLlm",
            {"baseUrl": "https://example.com/changed", "model": "new-model", "apiKey": "secret"},
        )
    state = await client.state()
    assert state["settings"]["llm"] == {
        "baseUrl": "https://example.com/changed",
        "model": "new-model",
    }
    assert not state["llmApiKeyConfigured"]


async def test_mcp_project_changes_notify_once_with_workspace_flag(
    client: Client, tmp_path: Path
) -> None:
    root = tmp_path / "agent project"
    root.mkdir()
    state = await client.state()

    def project_states() -> list[tuple[int, str, Any]]:
        return [
            item for item in client.events if item[1] == "state" and item[2]["reason"] == "project"
        ]

    async with httpx.AsyncClient(
        headers={
            "Authorization": "Bearer " + state["gatewayToken"],
            "Accept": "application/json, text/event-stream",
        }
    ) as http:
        endpoint = state["gateway"]["endpoint"]
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
            before = len(project_states())
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
            await client.wait_for(
                lambda item: item[1] == "state" and item[2]["reason"] == "project", before + 1
            )
            await asyncio.sleep(0.2)
            fresh = project_states()[before:]
            assert len(fresh) == 1
            assert fresh[0][2]["workspaceChanged"] is changed
            assert (await client.state())["project"]["rootPath"] == str(root)
    before = len(project_states())
    await client.invoke("projects.leaveProject")
    await client.wait_for(
        lambda item: item[1] == "state" and item[2]["reason"] == "project", before + 1
    )
    assert project_states()[before][2]["workspaceChanged"] is True
    assert "project" not in await client.state()
