from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import pytest
import uvicorn
from starlette.types import Receive, Scope, Send

from hardwareharness_backend.devices import DeviceTransportRegistry, McpHttpTransport, SshManager
from hardwareharness_backend.devices.mcp_client import McpCompatibilityError
from hardwareharness_backend.devices.mcp_transport import CompatibleHttpTransport
from hardwareharness_backend.devices.ssh import _execute, _HostKeyPolicy, fingerprint
from hardwareharness_backend.orchestration.cancellation import AbortController


class Remote:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.methods: list[str] = []
        self.headers: list[dict[str, str]] = []
        self.result: dict[str, Any] | None = None
        self.missing_list = False
        self.delay = 0.0
        self.hardware: Any = [{"hardwareId": "H", "state": "open", "health": "ok"}]
        self.url = ""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.methods.append(scope["method"])
        self.headers.append({k.decode(): v.decode() for k, v in scope["headers"]})
        status = 200
        result: dict[str, Any] = {}
        if scope["method"] == "GET":
            status = 405
        elif scope["method"] == "DELETE":
            status = 200
        else:
            data = b""
            while True:
                part = await receive()
                data += part.get("body", b"")
                if not part.get("more_body"):
                    break
            request = json.loads(data)
            self.requests.append(request)
            method = request["method"]
            if method == "initialize":
                result = {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fake", "version": "1"},
                }
            elif method == "tools/list":
                result = {
                    "tools": [
                        {
                            "name": "measure",
                            "description": "Measure",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "hardwareId": {"const": "H"},
                                    "channel": {"type": "integer"},
                                },
                                "required": ["hardwareId", "channel"],
                                "additionalProperties": False,
                            },
                            "outputSchema": {
                                "type": "object",
                                "properties": {"ok": {"const": True}, "data": {"type": "object"}},
                                "required": ["ok", "data"],
                            },
                            "_meta": {"hardwareharness": {"kind": "hardware"}},
                        },
                        {
                            "name": "hardwareharness_prepare_shutdown",
                            "inputSchema": {"type": "object"},
                            "_meta": {"hardwareharness": {"kind": "internal"}},
                        },
                    ]
                }
                if not self.missing_list:
                    result["tools"].append(
                        {
                            "name": "list_hardware",
                            "inputSchema": {"type": "object"},
                            "_meta": {"hardwareharness": {"kind": "internal"}},
                        }
                    )
            elif method == "tools/call":
                name = request["params"]["name"]
                if name == "list_hardware":
                    result = {
                        "content": [],
                        "structuredContent": {"ok": True, "data": self.hardware},
                    }
                elif name == "measure":
                    await asyncio.sleep(self.delay)
                    result = self.result or {
                        "content": [],
                        "structuredContent": {"ok": True, "data": {"value": 42}},
                    }
                else:
                    result = {"content": [{"type": "text", "text": "ready"}]}
            if "id" in request:
                result = {"jsonrpc": "2.0", "id": request["id"], "result": result}
            else:
                status = 202
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json"), (b"mcp-session-id", b"test")],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": json.dumps(result).encode() if status != 202 else b"",
            }
        )


@pytest.fixture
async def remote() -> AsyncIterator[Remote]:
    remote = Remote()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    remote.url = f"http://127.0.0.1:{listener.getsockname()[1]}/mcp"
    server = uvicorn.Server(
        uvicorn.Config(
            remote, lifespan="off", ws="none", http="h11", log_config=None, log_level="critical"
        )
    )
    task = asyncio.create_task(server.serve(sockets=[listener]))
    while not server.started:
        await asyncio.sleep(0.001)
    try:
        yield remote
    finally:
        server.should_exit = True
        await task


def server(remote: Remote) -> dict[str, Any]:
    return {
        "transport": "mcp-http",
        "serverId": "S",
        "computerId": "C",
        "hardwareId": "H",
        "url": remote.url,
        "enabled": True,
    }


async def test_real_mcp_session_metadata_validation_and_no_delete(remote: Remote) -> None:
    pool = McpHttpTransport(Mock(get=Mock(return_value={"token": "secret"})))
    try:
        one, two = await asyncio.gather(pool.connect(server(remote)), pool.connect(server(remote)))
        assert one is two
        assert one["hardware"]["hardwareId"] == "H"
        assert await pool.connect(server(remote)) is one
        assert await pool.ensure(server(remote)) is one
        assert pool.has_tool("S__measure")
        assert not pool.has_tool("missing")
        tools = pool.list_tools()
        assert len(tools) == 1 and tools[0]["description"] == "Measure"
        assert "hardwareId" not in tools[0]["inputSchema"]["properties"]
        assert "hardwareId" not in tools[0]["inputSchema"]["required"]
        assert pool.find_tool("S__measure")["session"] is one
        with pytest.raises(RuntimeError, match="Unknown aggregated tool"):
            pool.find_tool("missing")
        output = await pool.call(
            "S__measure",
            {"channel": 2},
            {
                "metadata": {
                    "hardwareId": "H",
                    "attempt": 2,
                    "idempotencyKey": "same",
                    "occupancyLeaseId": "L",
                }
            },
        )
        assert output == {"value": 42}
        call = next(
            request for request in reversed(remote.requests) if request["method"] == "tools/call"
        )
        assert call["params"]["arguments"] == {"hardwareId": "H", "channel": 2}
        assert call["params"]["_meta"]["hardwareharness"]["occupancyLeaseId"] == "L"
        assert any(h.get("authorization") == "Bearer secret" for h in remote.headers)
        assert (await pool.list_hardware([server(remote), {**server(remote), "enabled": False}]))[
            0
        ]["serverId"] == "S"
        assert await pool.prepare_shutdown("S") == [{"type": "text", "text": "ready"}]
        assert await pool.call_internal(server(remote), "hardwareharness_prepare_shutdown", {}) == [
            {"type": "text", "text": "ready"}
        ]
        remote.result = {"content": []}
        with pytest.raises(McpCompatibilityError, match="did not return structured"):
            await pool.call("S__measure", {"channel": 2}, {"metadata": {"hardwareId": "H"}})
        remote.result = {"content": [], "isError": True, "structuredContent": {"ok": False}}
        with pytest.raises(McpCompatibilityError, match="does not match"):
            await pool.call("S__measure", {"channel": 2}, {"metadata": {"hardwareId": "H"}})
        remote.result = {"content": [], "isError": True}
        assert (
            await pool.call("S__measure", {"channel": 2}, {"metadata": {"hardwareId": "H"}}) == []
        )
        await pool.disconnect("S")
        assert pool.list_tools() == []
        with pytest.raises(RuntimeError, match="not connected"):
            await pool.call_remote("S", "measure", {})
    finally:
        await pool.close()
    assert "DELETE" not in remote.methods


async def test_mcp_connection_failure_isolated_and_schema_enforced(remote: Remote) -> None:
    pool = McpHttpTransport(Mock(get=Mock(return_value={"token": "secret"})))
    remote.missing_list = True
    with pytest.raises(RuntimeError, match="must expose list_hardware"):
        await pool.connect(server(remote))
    remote.missing_list = False
    remote.hardware = []
    with pytest.raises(RuntimeError, match="one-Server-one-hardware"):
        await pool.connect(server(remote))
    assert await pool.list_hardware([server(remote)]) == []
    await pool.close()


async def test_mcp_timeout_emits_cancellation_and_connection_remains_usable(remote: Remote) -> None:
    pool = McpHttpTransport(Mock(get=Mock(return_value={"token": "secret"})))
    await pool.connect(server(remote))
    remote.delay = 0.1
    try:
        with pytest.raises(McpCompatibilityError, match="Request timed out"):
            await pool.call(
                "S__measure", {"channel": 1}, {"timeoutMs": 10, "metadata": {"hardwareId": "H"}}
            )
        await asyncio.sleep(0.02)
        cancellations = [r for r in remote.requests if r["method"] == "notifications/cancelled"]
        assert len(cancellations) == 1
        call = next(
            r
            for r in remote.requests
            if r["method"] == "tools/call" and r["params"]["name"] == "measure"
        )
        assert cancellations[0]["params"]["requestId"] == call["id"]
        remote.delay = 0
        assert await pool.call("S__measure", {"channel": 2}, {"metadata": {"hardwareId": "H"}}) == {
            "value": 42
        }
    finally:
        await pool.close()


async def test_mcp_abort_signal_preserves_reason_and_required_task_rejection(
    remote: Remote,
) -> None:
    pool = McpHttpTransport(Mock(get=Mock(return_value={"token": "secret"})))
    session = await pool.connect(server(remote))
    controller = AbortController()
    reason = RuntimeError("operator cancelled")
    options = {"signal": controller.signal, "metadata": {"hardwareId": "H"}}
    try:
        controller.abort(reason)
        with pytest.raises(RuntimeError) as failure:
            await pool.call("S__measure", {"channel": 1}, options)
        assert failure.value is reason
        assert not any(r.get("params", {}).get("name") == "measure" for r in remote.requests)
        controller = AbortController()
        remote.delay = 0.2
        calling = asyncio.create_task(
            pool.call(
                "S__measure",
                {"channel": 1},
                {"signal": controller.signal, "metadata": {"hardwareId": "H"}},
            )
        )
        for _ in range(100):
            if any(r.get("params", {}).get("name") == "measure" for r in remote.requests):
                break
            await asyncio.sleep(0.001)
        controller.abort(reason)
        with pytest.raises(RuntimeError) as failure:
            await calling
        assert failure.value is reason
        for _ in range(100):
            if any(r["method"] == "notifications/cancelled" for r in remote.requests):
                break
            await asyncio.sleep(0.005)
        cancellation = next(r for r in remote.requests if r["method"] == "notifications/cancelled")
        request = next(r for r in remote.requests if r.get("params", {}).get("name") == "measure")
        assert cancellation["params"] == {
            "requestId": request["id"],
            "reason": "operator cancelled",
        }
        session["client"].required_tasks.add("measure")
        with pytest.raises(McpCompatibilityError, match="requires task-based execution"):
            await pool.call("S__measure", {"channel": 1}, {"metadata": {"hardwareId": "H"}})
    finally:
        await pool.close()


async def test_registry_routes_isolates_and_closes() -> None:
    transport = Mock(
        kind="mcp-http",
        connect=AsyncMock(return_value={"hardware": {}}),
        disconnect=AsyncMock(),
        close=AsyncMock(),
        list_tools=Mock(return_value=[{"name": "x"}]),
        has_tool=Mock(side_effect=lambda name: name == "x"),
        call=AsyncMock(return_value=1),
        call_internal=AsyncMock(return_value=2),
        prepare_shutdown=AsyncMock(return_value=3),
        describe_hardware=AsyncMock(side_effect=[{"hardwareId": "A"}, RuntimeError("offline")]),
    )
    registry = DeviceTransportRegistry([transport])
    with pytest.raises(RuntimeError, match="Duplicate device"):
        DeviceTransportRegistry([transport, transport])
    a = {"serverId": "S", "transport": "mcp-http", "enabled": True}
    assert await registry.connect(a) == {"hardware": {}}
    assert registry.list_tools() == [{"name": "x"}]
    assert await registry.call_tool("x", {}) == 1
    with pytest.raises(RuntimeError, match="Unknown aggregated"):
        await registry.call_tool("missing", {})
    assert await registry.call_internal(a, "name", {}) == 2
    assert await registry.prepare_shutdown(a) == 3
    assert await registry.list_hardware([a, {**a, "serverId": "B"}, {**a, "enabled": False}]) == [
        {"hardwareId": "A"}
    ]
    await registry.disconnect("S")
    await registry.disconnect("unknown")
    with pytest.raises(RuntimeError, match="Unsupported device"):
        await registry.connect({"transport": "unknown"})
    await registry.close()
    transport.close.assert_awaited_once()


async def test_ssh_cache_credentials_generation_timeout_and_close() -> None:
    credential = {"kind": "password", "password": "one"}
    secrets = Mock(get=Mock(side_effect=lambda _: credential.copy()))
    manager = SshManager(secrets)
    computer = {"id": "C", "address": "localhost", "ssh": {"port": 22, "username": "user"}}
    clients = [Mock() for _ in range(3)]
    with patch.object(manager, "_open", side_effect=clients):
        first, same = await asyncio.gather(manager._connect(computer), manager._connect(computer))
        assert first is same
        assert await manager._connect(computer) is first
        credential["password"] = "two"
        assert await manager._connect(computer) is clients[1]
        clients[0].close.assert_called_once()
        with patch("hardwareharness_backend.devices.ssh._execute", return_value={"stdout": "ok"}):
            assert await manager.execute(computer, "cmd") == {"stdout": "ok"}
        with (
            patch("hardwareharness_backend.devices.ssh._execute", side_effect=TimeoutError()),
            pytest.raises(RuntimeError, match="timed out after 5 ms"),
        ):
            await manager.execute(computer, "cmd", 5)
        assert not manager.clients
        await manager.close()
        await manager.close()
        with pytest.raises(RuntimeError, match="closed"):
            await manager._connect(computer)


def test_ssh_drain_fingerprint_and_connection_config() -> None:
    channel = Mock(
        recv_ready=Mock(side_effect=[True, False]),
        recv_stderr_ready=Mock(side_effect=[True, False]),
        recv=Mock(return_value=b"output"),
        recv_stderr=Mock(return_value=b"error"),
        exit_status_ready=Mock(return_value=True),
        recv_exit_status=Mock(return_value=7),
    )
    stdin = Mock()
    client = Mock(exec_command=Mock(return_value=(stdin, Mock(channel=channel), Mock())))
    result = _execute(client, "cmd", 1000, 4)
    assert result["stdout"] == "outp" and result["stderr"] == "erro"
    assert result["exitCode"] == 7 and result["truncated"]
    stdin.close.assert_called_once()
    key = Mock(asbytes=Mock(return_value=b"key"))
    _HostKeyPolicy(fingerprint(b"key")).missing_host_key(Mock(), "host", key)
    with pytest.raises(Exception, match="verification failed"):
        _HostKeyPolicy("wrong").missing_host_key(Mock(), "host", key)
    manager = SshManager(Mock(get=Mock(return_value={"kind": "password", "password": "secret"})))
    with patch("paramiko.SSHClient") as factory:
        mocked_client: Any = factory.return_value
        opened = manager._open({"id": "C", "address": "host", "ssh": {"port": 22, "username": "u"}})
        assert opened is factory.return_value
        assert mocked_client.connect.call_args.kwargs["password"] == "secret"
        mocked_client.get_transport.return_value.set_keepalive.assert_called_once_with(5)


def test_backoff_matches_ts_options() -> None:
    assert [CompatibleHttpTransport.retry_delay(i) for i in range(5)] == pytest.approx(
        [1, 1.8, 3.24, 5.832, 10.4976]
    )
    assert CompatibleHttpTransport.retry_delay(20) == 30
    assert CompatibleHttpTransport.retry_delay(20, 75) == 0.075
