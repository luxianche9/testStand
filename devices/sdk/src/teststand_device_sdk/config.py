"""Identity and settings of one hosted device."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

DRY_RUN_ENV = "HARDWARE_DRY_RUN"
_TRUE = {"1", "true", "yes", "on"}


def env_flag(name: str, env: Mapping[str, str] | None = None) -> bool:
    return (os.environ if env is None else env).get(name, "").strip().lower() in _TRUE


@dataclass(frozen=True)
class DeviceConfig:
    """Identity of one hosted device and its adapter settings.

    ``settings`` carries adapter-specific, nonsecret options; drivers may still
    read their historical environment variables. ``build`` (source revision,
    SDK version) is reported by ``get_device_info`` when the host knows it.
    """

    device_id: str
    hardware_id: str
    manufacturer: str
    model: str
    computer_id: str = "LOCAL"
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
    ) -> DeviceConfig:
        missing = [key for key in ("deviceId", "hardwareId", "manufacturer", "model") if not data.get(key)]
        if missing:
            raise ValueError(f"Device config is missing: {', '.join(missing)}")
        return cls(
            device_id=str(data["deviceId"]),
            hardware_id=str(data["hardwareId"]),
            manufacturer=str(data["manufacturer"]),
            model=str(data["model"]),
            computer_id=str(data.get("computerId", "LOCAL")),
            dry_run=bool(data.get("dryRun", False)) or env_flag(DRY_RUN_ENV, env),
            settings=dict(data.get("settings", {})),
            build=dict(build if build is not None else data.get("build", {})),
        )
