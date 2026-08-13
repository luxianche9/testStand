from __future__ import annotations

import json
import os
from ipaddress import ip_address
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

DEFAULT_CONFIG_NAME = "server.json"


class ServerConfig(BaseModel):
    """Deployment-specific configuration loaded from server.json and environment."""

    serverId: str
    hardwareId: str
    manufacturer: str
    model: str
    serverVersion: str = "0.1.0"
    host: str = "127.0.0.1"
    port: int
    token: str = ""
    simulate: bool = False
    allowInsecureRemote: bool = False
    driver: dict[str, Any] = Field(default_factory=dict)


def _config_path() -> Path:
    override = os.environ.get("TESTFORGE_SERVER_CONFIG")
    return Path(override) if override else Path.cwd() / DEFAULT_CONFIG_NAME


def load_config() -> ServerConfig:
    path = _config_path()
    raw: dict[str, Any] = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    if value := os.environ.get("TESTFORGE_SERVER_ID"):
        raw["serverId"] = value
    if value := os.environ.get("TESTFORGE_HARDWARE_ID"):
        raw["hardwareId"] = value
    if value := os.environ.get("TESTFORGE_PORT"):
        raw["port"] = int(value)
    if value := os.environ.get("TESTFORGE_HOST"):
        raw["host"] = value
    if value := os.environ.get("TESTFORGE_TOKEN") or os.environ.get("TESTFORGE_MCP_TOKEN"):
        raw["token"] = value
    if os.environ.get("TESTFORGE_SIMULATE") == "1":
        raw["simulate"] = True
    if os.environ.get("TESTFORGE_ALLOW_INSECURE_REMOTE") == "1":
        raw["allowInsecureRemote"] = True
    raw.setdefault("serverId", "{{SERVER_ID}}")
    raw.setdefault("hardwareId", "{{HARDWARE_ID}}")
    raw.setdefault("manufacturer", "{{MANUFACTURER}}")
    raw.setdefault("model", "{{MODEL}}")
    raw.setdefault("port", 8001)
    raw.setdefault("token", "")
    config = ServerConfig.model_validate(raw)
    if not config.token:
        raise RuntimeError("A bearer token is required in server.json or TESTFORGE_MCP_TOKEN")
    if not _is_loopback(config.host) and not config.allowInsecureRemote:
        raise RuntimeError(
            "Refusing to expose bearer-token HTTP on a non-loopback address. "
            "Use an SSH tunnel/VPN, or explicitly set allowInsecureRemote=true."
        )
    return config


def _is_loopback(host: str) -> bool:
    if host.strip().lower() == "localhost":
        return True
    try:
        return ip_address(host.strip()).is_loopback
    except ValueError:
        return False
