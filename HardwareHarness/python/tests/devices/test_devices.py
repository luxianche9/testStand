from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.contracts.validation import ValidationError
from hardwareharness_backend.devices import (
    DeviceService,
    DeviceStore,
    McpHttpTransport,
)

SERVICE = "packages/devices/src/device-service.test.ts::"
MCP = "packages/devices/src/mcp-client.test.ts::"


def server(identifier: str = "PCI1710L_MCP") -> dict[str, Any]:
    return {
        "transport": "mcp-http",
        "serverId": identifier,
        "label": identifier,
        "hardwareId": identifier + ".HARDWARE_0",
        "url": "http://127.0.0.1:8011/mcp",
        "enabled": True,
    }


async def fixture(tmp_path: Path, broken: str) -> DeviceService:
    store = DeviceStore(tmp_path)
    await store.initialize()

    async def connect(target: dict[str, Any]) -> dict[str, Any]:
        if target["serverId"] == broken:
            raise RuntimeError("vendor SDK hung: " + broken)
        return {}

    pool = Mock(
        connect=AsyncMock(side_effect=connect),
        disconnect=AsyncMock(),
        list_tools=Mock(return_value=[]),
        list_hardware=AsyncMock(return_value=[]),
    )
    secrets = Mock(set=AsyncMock(), remove=AsyncMock())
    service = DeviceService(store, secrets, pool)
    for identifier in ["PCI1710L_MCP", "PCI1762_MCP", "PCI6208V_MCP"]:
        await service.save_server(server(identifier), {"mcpToken": "token"})
    return service


@pytest.mark.ts_case(SERVICE + "reports every server when one of them fails to connect")
async def test_server_isolation(tmp_path: Path) -> None:
    service = await fixture(tmp_path, "PCI1762_MCP")
    statuses = await service.refresh_all_servers()
    assert len(statuses) == 3
    assert (
        next(s for s in statuses if s["serverId"] == "PCI1762_MCP")["transport"]["state"]
        == "offline"
    )
    assert [s["serverId"] for s in statuses if s["transport"]["state"] == "online"] == [
        "PCI1710L_MCP",
        "PCI6208V_MCP",
    ]


@pytest.mark.ts_case(
    SERVICE + "keeps a failing server's error on its own status instead of throwing"
)
async def test_error_status(tmp_path: Path) -> None:
    status = await (await fixture(tmp_path, "PCI1762_MCP")).refresh_server("PCI1762_MCP")
    assert status["transport"]["state"] == "offline"
    assert "vendor SDK hung" in status["transport"]["message"]


@pytest.mark.ts_case(
    SERVICE + "resolves an unknown serverId into an error status rather than an exception"
)
async def test_unknown_server(tmp_path: Path) -> None:
    status = await (await fixture(tmp_path, "none")).refresh_server("NOT_REGISTERED")
    assert status["transport"]["state"] == "error"


def hardware() -> dict[str, Any]:
    return {
        "hardwareId": server()["hardwareId"],
        "capabilities": ["read_status"],
        "state": "open",
        "health": "ok",
    }


def transport(response: Any) -> McpHttpTransport:
    pool = McpHttpTransport(Mock())
    pool.__dict__["call_remote"] = AsyncMock(return_value=response)
    return pool


@pytest.mark.parametrize(
    "response",
    [
        pytest.param([], marks=pytest.mark.ts_case(MCP + "rejects a zero list_hardware response")),
        pytest.param(
            [hardware(), {**hardware(), "hardwareId": "SECOND"}],
            marks=pytest.mark.ts_case(MCP + "rejects a multiple list_hardware response"),
        ),
        pytest.param(
            {"hardware": hardware()},
            marks=pytest.mark.ts_case(MCP + "rejects a non-array list_hardware response"),
        ),
    ],
)
async def test_single_hardware(response: Any) -> None:
    with pytest.raises(Exception, match="violates one-Server-one-hardware"):
        await transport(response)._refresh_single_hardware({"server": server()})


@pytest.mark.ts_case(MCP + "rejects a hardwareId that differs from the saved Server identity")
async def test_hardware_identity() -> None:
    with pytest.raises(Exception, match="expected " + server()["hardwareId"]):
        await transport([{**hardware(), "hardwareId": "WRONG.HARDWARE"}])._refresh_single_hardware(
            {"server": server()}
        )


@pytest.mark.ts_case(MCP + "ignores identity a Server has no business asserting")
async def test_ignored_identity() -> None:
    pool = transport([{**hardware(), "manufacturer": "Wrong vendor", "model": "Wrong model"}])
    result = await pool._refresh_single_hardware({"server": server()})
    assert result["hardwareId"] == server()["hardwareId"]


@pytest.mark.ts_case(MCP + "injects the owning Server into a valid hardware record")
async def test_owning_computer() -> None:
    result = await transport([hardware()])._refresh_single_hardware({"server": server()})
    assert result["hardwareId"] == server()["hardwareId"]
    assert result["serverId"] == server()["serverId"]


def call_fixture(maximum: int | None = None) -> tuple[McpHttpTransport, AsyncMock]:
    pool = McpHttpTransport(Mock())
    call_tool = AsyncMock(return_value={"structuredContent": {"ok": True, "data": {"value": 1}}})
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "hardwareId": {"const": server()["hardwareId"]},
            "channel": {
                "type": "integer",
                **({"minimum": 0, "maximum": maximum} if maximum is not None else {}),
            },
        },
        "required": ["hardwareId", "channel"],
    }
    pool.sessions[server()["serverId"]] = {
        "server": server(),
        "client": Mock(call_tool=call_tool),
        "validators": {"read_channel": {"input": schema, "injectHardwareId": True}},
    }
    return pool, call_tool


@pytest.mark.ts_case(MCP + "uses AJV for the authoritative pre-call input validation")
async def test_input_schema() -> None:
    pool, call_tool = call_fixture(3)
    with pytest.raises(Exception, match="Invalid input") as failure:
        await pool.call_remote(
            server()["serverId"],
            "read_channel",
            {"channel": 9},
            {"metadata": {"hardwareId": server()["hardwareId"]}},
        )
    assert getattr(failure.value, "category", None) == "invalid_argument"
    call_tool.assert_not_awaited()


@pytest.mark.ts_case(
    MCP + "sends execution context through MCP _meta and injects hardwareId only "
    "for legacy-declared schemas"
)
async def test_call_metadata() -> None:
    pool, call_tool = call_fixture()
    metadata = {
        "hardwareId": server()["hardwareId"],
        "attempt": 2,
        "idempotencyKey": "stable-key",
        "traceId": "trace-1",
    }
    assert await pool.call_remote(
        server()["serverId"], "read_channel", {"channel": 2}, {"metadata": metadata}
    ) == {"value": 1}
    call_tool.assert_awaited_once_with(
        "read_channel",
        {"hardwareId": server()["hardwareId"], "channel": 2},
        meta={"hardwareharness": metadata},
        options={},
    )


@pytest.mark.ts_case(MCP + "rejects untrusted hardware state before it reaches availability logic")
async def test_untrusted_state() -> None:
    with pytest.raises(ValidationError):
        await transport(
            [{**hardware(), "state": "vendor-specific-ready"}]
        )._refresh_single_hardware({"server": server()})
