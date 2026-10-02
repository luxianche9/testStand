"""Existing services: import from ``services.json`` or add by URL + token (design doc 4.8.3)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest

from hardwareharness_backend.application import HUMAN_REQUEST_CONTEXT as HUMAN
from hardwareharness_backend.application import DefaultAuthorizer
from hardwareharness_backend.application.services import DevicesApplication
from hardwareharness_backend.devices import DeviceCatalogService, DeviceService, DeviceStore
from hardwareharness_backend.devices.service_registry import (
    mcp_url,
    parse_registry,
    probe_service,
    read_token_script,
)

ROOT = r"E:\pci1710l_mcp_server"
REGISTRY = {
    "formatVersion": 1,
    "services": [
        {
            "serverId": "PCI1710L_MCP",
            "hardwareId": "PC1_MCP.PCI1710L_CARD_0",
            "adapter": "hh_adapter_pci1710l",
            "adapterVersion": "0.3.0",
            "root": ROOT,
            "port": 8011,
            "installedAt": "2026-09-30T10:00:00+08:00",
        },
        {"serverId": "BROKEN", "root": "E:\\x", "port": "8012"},
    ],
}
TOKEN = "t0k3n-value"


def test_registry_parsing_skips_malformed_entries() -> None:
    entries = parse_registry(json.dumps(REGISTRY))
    assert [entry["serverId"] for entry in entries] == ["PCI1710L_MCP"]
    assert entries[0]["adapterVersion"] == "0.3.0"
    for bad in ("not json", json.dumps({"formatVersion": 2, "services": []})):
        with pytest.raises(Exception) as caught:
            parse_registry(bad)
        assert getattr(caught.value, "category", None) == "invalid_response"


def test_addresses_and_token_script() -> None:
    assert mcp_url("http://10.0.0.2:8011") == "http://10.0.0.2:8011/mcp"
    assert mcp_url(" http://10.0.0.2:8011/mcp/ ") == "http://10.0.0.2:8011/mcp"
    with pytest.raises(Exception, match="Not an http"):
        mcp_url("10.0.0.2:8011")
    assert read_token_script("E:\\it's\\") == (
        "(Get-Content -Raw -LiteralPath 'E:\\it''s\\server.json' | ConvertFrom-Json).token"
    )


def http_service(token: str = TOKEN, device_status: int = 200) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            assert "authorization" not in request.headers
            return httpx.Response(
                200, json={"healthy": True, "serverId": "SCOPE_MCP", "hardwareId": "SCOPE_0"}
            )
        assert request.url.path == "/device"
        if request.headers.get("authorization") != f"Bearer {token}":
            return httpx.Response(401)
        return httpx.Response(
            device_status,
            json={
                "manifestRevision": "sha256:1",
                "identity": {"hardwareId": "SCOPE_0", "manufacturer": "Rigol", "model": "DS1104"},
            },
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_probe_reads_health_then_device_with_the_token() -> None:
    async with http_service() as http:
        identity = await probe_service("http://10.0.0.9:8020/mcp", TOKEN, http)
    assert identity == {
        "serverId": "SCOPE_MCP",
        "hardwareId": "SCOPE_0",
        "label": "Rigol DS1104",
        "healthy": True,
    }
    async with http_service() as http:
        with pytest.raises(Exception, match="rejected the token") as caught:
            await probe_service("http://10.0.0.9:8020/mcp", "wrong", http)
    assert getattr(caught.value, "category", None) == "permission_denied"
    assert TOKEN not in str(caught.value)


async def application(tmp_path: Path) -> tuple[DevicesApplication, DeviceService, Mock]:
    store = DeviceStore(tmp_path)
    await store.initialize()
    secrets = Mock(set=AsyncMock(), remove=AsyncMock())
    transports = Mock(
        connect=AsyncMock(side_effect=RuntimeError("offline")),
        disconnect=AsyncMock(),
        list_tools=Mock(return_value=[]),
    )
    service = DeviceService(store, secrets, transports)
    await service.save_computer(
        {"id": "PC1", "label": "PC1", "address": "192.168.3.63", "ssh": {"username": "u"}},
        {"ssh": "secret"},
    )
    return (
        DevicesApplication(DefaultAuthorizer(), service, DeviceCatalogService(store)),
        service,
        secrets,
    )


async def test_import_from_a_computer_stores_the_token_only_in_the_keyring(tmp_path: Path) -> None:
    app, service, secrets = await application(tmp_path)

    async def execute(_computer: str, command: str, _timeout: int = 0) -> dict[str, Any]:
        stdout = TOKEN if "server.json" in command else json.dumps(REGISTRY)
        return {"stdout": stdout, "stderr": "", "exitCode": 0, "truncated": False}

    with patch.object(service, "execute", side_effect=execute):
        found = await app.discover_services(HUMAN, "PC1")
        assert found[0]["url"] == "http://192.168.3.63:8011/mcp"
        assert found[0]["added"] is False
        result = await app.import_services(HUMAN, "PC1", ["PCI1710L_MCP", "MISSING"])
        assert (await app.discover_services(HUMAN, "PC1"))[0]["added"] is True
        again = await app.import_services(HUMAN, "PC1", ["PCI1710L_MCP"])

    assert TOKEN not in json.dumps(result)
    assert [item["server"]["serverId"] for item in result["imported"]] == ["PCI1710L_MCP"]
    assert result["skipped"] == [{"serverId": "MISSING", "reason": "not in services.json"}]
    assert again["skipped"] == [{"serverId": "PCI1710L_MCP", "reason": "already added"}]
    server = service.list_servers()[0]
    assert server["root"] == ROOT and server["computerId"] == "PC1" and "lifecycle" not in server
    secrets.set.assert_any_await("mcp:PCI1710L_MCP", {"token": TOKEN})
    hardware = app.catalog.get_hardware("PC1_MCP.PCI1710L_CARD_0")
    assert hardware["kind"] == "managed" and hardware["serverId"] == "PCI1710L_MCP"


async def test_add_by_url_creates_an_unmanaged_service(tmp_path: Path) -> None:
    app, service, secrets = await application(tmp_path)
    identity = {"serverId": "SCOPE_MCP", "hardwareId": "SCOPE_0", "label": "Rigol", "healthy": True}
    with patch(
        "hardwareharness_backend.application.services.probe_service",
        AsyncMock(return_value=identity),
    ) as probe:
        result = await app.add_server_by_url(HUMAN, "http://10.0.0.9:8020", TOKEN)
        with pytest.raises(Exception, match="already added") as caught:
            await app.add_server_by_url(HUMAN, "http://10.0.0.9:8020", TOKEN)
    assert getattr(caught.value, "category", None) == "conflict"
    probe.assert_awaited_with("http://10.0.0.9:8020/mcp", TOKEN)
    assert result["server"]["url"] == "http://10.0.0.9:8020/mcp"
    assert "computerId" not in result["server"]
    assert "computerId" not in app.catalog.get_hardware("SCOPE_0")
    secrets.set.assert_any_await("mcp:SCOPE_MCP", {"token": TOKEN})
    with pytest.raises(Exception, match="added by URL"):
        await service.server_action("SCOPE_MCP", "start")
