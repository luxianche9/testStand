"""Server configuration loaded from ``HARDWAREHARNESS_SERVER_CONFIG``."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CONFIG_ENV = "HARDWAREHARNESS_SERVER_CONFIG"
DRY_RUN_ENV = "HARDWARE_DRY_RUN"
_TRUE = {"1", "true", "yes", "on"}


def env_flag(name: str, env: Mapping[str, str] | None = None) -> bool:
    return (os.environ if env is None else env).get(name, "").strip().lower() in _TRUE


@dataclass(frozen=True)
class ServerConfig:
    """Identity and network settings of one single-device server.

    ``settings`` carries adapter-specific, nonsecret options; drivers may still
    read their historical environment variables. ``build`` is the assembled
    bundle's ``build.json`` (source revision, SDK version) when present.
    """

    server_id: str
    hardware_id: str
    manufacturer: str
    model: str
    port: int = 0
    host: str = "0.0.0.0"
    token: str = ""
    computer_id: str = "REMOTE_PC_1"
    dry_run: bool = False
    settings: Mapping[str, Any] = field(default_factory=dict)
    build: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(
        cls,
        data: Mapping[str, Any],
        *,
        env: Mapping[str, str] | None = None,
        build: Mapping[str, Any] | None = None,
    ) -> ServerConfig:
        missing = [key for key in ("serverId", "hardwareId", "manufacturer", "model") if not data.get(key)]
        if missing:
            raise ValueError(f"Server config is missing: {', '.join(missing)}")
        return cls(
            server_id=str(data["serverId"]),
            hardware_id=str(data["hardwareId"]),
            manufacturer=str(data["manufacturer"]),
            model=str(data["model"]),
            port=int(data.get("port", 0)),
            host=str(data.get("host", "0.0.0.0")),
            token=str(data.get("token", "")),
            computer_id=str(data.get("computerId", "REMOTE_PC_1")),
            dry_run=bool(data.get("dryRun", False)) or env_flag(DRY_RUN_ENV, env),
            settings=dict(data.get("settings", {})),
            build=dict(build if build is not None else data.get("build", {})),
        )

    @classmethod
    def load(cls, path: str | os.PathLike[str] | None = None, *, env: Mapping[str, str] | None = None) -> ServerConfig:
        env = os.environ if env is None else env
        location = path or env.get(CONFIG_ENV)
        if not location:
            raise RuntimeError(f"{CONFIG_ENV} is required")
        config_path = Path(location)
        data = json.loads(config_path.read_text(encoding="utf-8-sig"))
        build_path = config_path.with_name("build.json")
        build = json.loads(build_path.read_text(encoding="utf-8-sig")) if build_path.is_file() else None
        return cls.from_mapping(data, env=env, build=build)
