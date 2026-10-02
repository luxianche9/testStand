"""Finding services that already exist (design doc 4.8.3).

Two ways in: a computer's ``services.json`` (written by ``install.ps1``) lists every installed
service; a bare URL + token is probed through ``/health`` and ``/device``. Tokens are read
from the service's own ``server.json`` and only ever go to the keyring.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit

import httpx

from hardwareharness_backend.contracts.devices import parse_hardware, parse_mcp_server
from hardwareharness_backend.contracts.errors import app_error

from .device_manifest import fetch_device, service_base_url
from .lifecycle import ps_quote

Record = dict[str, Any]

SERVICES_JSON = r"C:\ProgramData\HardwareHarness\services.json"
_REGISTRY_FIELDS = ("serverId", "hardwareId", "root", "port")


def read_registry_script() -> str:
    path = ps_quote(SERVICES_JSON)
    return (
        f"if (Test-Path -LiteralPath {path}) {{ Get-Content -Raw -LiteralPath {path} }} "
        'else { \'{"formatVersion":1,"services":[]}\' }'
    )


def parse_registry(stdout: str) -> list[Record]:
    try:
        document = json.loads(stdout.strip() or "{}")
    except json.JSONDecodeError as error:
        raise app_error("invalid_response", f"{SERVICES_JSON} is not valid JSON") from error
    if not isinstance(document, dict) or document.get("formatVersion") != 1:
        raise app_error("invalid_response", f"{SERVICES_JSON} has an unsupported formatVersion")
    services = document.get("services")
    if not isinstance(services, list):
        raise app_error("invalid_response", f"{SERVICES_JSON} has no services list")
    entries: list[Record] = []
    for item in services:
        if not isinstance(item, dict) or any(key not in item for key in _REGISTRY_FIELDS):
            continue
        if not isinstance(item["port"], int) or not 0 < item["port"] < 65536:
            continue
        entries.append(
            {
                key: item[key]
                for key in (*_REGISTRY_FIELDS, "adapter", "adapterVersion", "installedAt")
                if key in item
            }
        )
    return entries


def read_token_script(root: str) -> str:
    path = ps_quote(root.rstrip("\\/") + "\\server.json")
    return f"(Get-Content -Raw -LiteralPath {path} | ConvertFrom-Json).token"


def mcp_url(base: str) -> str:
    """Accept ``http://host:port`` or ``http://host:port/mcp``; return the MCP endpoint."""
    parts = urlsplit(base.strip())
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise app_error("invalid_argument", f"Not an http(s) service address: {base!r}")
    return f"{parts.scheme}://{parts.netloc}/mcp"


async def probe_service(url: str, token: str, http: httpx.AsyncClient | None = None) -> Record:
    """``/health`` (public) then ``/device`` (token); the identity the service reports."""
    owned = http is None
    client = http or httpx.AsyncClient(timeout=10, trust_env=False)
    try:
        try:
            health_response = await client.get(service_base_url(url) + "/health")
        except httpx.HTTPError as error:
            raise app_error("unavailable", f"{service_base_url(url)} is not reachable") from error
        if health_response.status_code != 200:
            raise app_error("unavailable", f"/health answered HTTP {health_response.status_code}")
        health = health_response.json()
        if not isinstance(health, dict) or not health.get("serverId"):
            raise app_error(
                "invalid_response", "/health did not identify a HardwareHarness service"
            )
        client.headers["Authorization"] = f"Bearer {token}"
        try:
            device = await fetch_device(client, url)
        except RuntimeError as error:
            raise app_error("invalid_response", str(error)) from error
        except httpx.HTTPStatusError as error:
            if error.response.status_code in {401, 403}:
                raise app_error("permission_denied", "The service rejected the token") from error
            raise app_error(
                "unavailable", f"/device answered HTTP {error.response.status_code}"
            ) from error
        identity = (device or {}).get("identity") or {}
        hardware_id = identity.get("hardwareId") or health.get("hardwareId")
        if not hardware_id:
            raise app_error("invalid_response", "The service did not report its hardwareId")
        label = " ".join(
            str(part) for part in (identity.get("manufacturer"), identity.get("model")) if part
        )
        return {
            "serverId": str(health["serverId"]),
            "hardwareId": str(hardware_id),
            "label": label or str(health["serverId"]),
            "healthy": bool(health.get("healthy")),
        }
    finally:
        client.headers.pop("Authorization", None)
        if owned:
            await client.aclose()


async def register_service(devices: Any, catalog: Any, server: Record, token: str) -> Record:
    """Save the service with its token and the managed hardware entry it drives."""
    existing = catalog.find_hardware(server["hardwareId"])
    if existing and existing.get("serverId") != server["serverId"]:
        raise app_error(
            "conflict",
            f"Hardware {server['hardwareId']} already exists and is not bound to "
            f"{server['serverId']}",
        )
    saved = await devices.save_server(parse_mcp_server(server), {"mcpToken": token})
    if existing is None:
        await catalog.save_hardware(
            parse_hardware(
                {
                    "formatVersion": 2,
                    "hardwareId": server["hardwareId"],
                    "label": server["label"],
                    "kind": "managed",
                    "serverId": server["serverId"],
                    **({"computerId": server["computerId"]} if "computerId" in server else {}),
                }
            )
        )
    return {"server": saved, "status": await devices.refresh_server(server["serverId"])}
