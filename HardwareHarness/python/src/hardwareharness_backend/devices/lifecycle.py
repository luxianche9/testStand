"""Service lifecycle commands derived from the install ``root`` (design doc 4.8.2).

A service deployed from a bundle has ``status.ps1``/``start.ps1``/``stop.ps1`` and ``logs\\``
under its root, so nothing needs to be typed in. ``server.lifecycle`` only overrides single
commands for non-standard installs (FireDAP, a process on the local computer).
"""

from __future__ import annotations

from typing import Any

from hardwareharness_backend.contracts.errors import app_error

Record = dict[str, Any]

LIFECYCLE_KEYS = ("statusCommand", "startCommand", "stopCommand", "forceStopCommand", "logPath")


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def derived_lifecycle(root: str) -> Record:
    base = root.rstrip("\\/")

    def script(name: str) -> str:
        return f"& {ps_quote(base + chr(92) + name)}"

    return {
        "statusCommand": script("status.ps1"),
        "startCommand": script("start.ps1"),
        "stopCommand": script("stop.ps1"),
        "forceStopCommand": script("stop.ps1") + " -Force",
        "logPath": base + "\\logs",
    }


def lifecycle_of(server: Record) -> Record:
    """Effective commands: the root-derived defaults with the stored overrides on top."""
    overrides = server.get("lifecycle") or {}
    derived = derived_lifecycle(server["root"]) if server.get("root") else {}
    merged = {key: overrides.get(key) or derived.get(key) for key in LIFECYCLE_KEYS}
    if not merged["forceStopCommand"] and overrides.get("stopCommand"):
        merged["forceStopCommand"] = overrides["stopCommand"]
    return {key: value for key, value in merged.items() if value}


def is_managed(server: Record) -> bool:
    """A service the terminal can start and stop: it has a computer and a status command."""
    return bool(server.get("computerId")) and "statusCommand" in lifecycle_of(server)


def lifecycle_command(server: Record, key: str) -> str:
    if not server.get("computerId"):
        raise app_error(
            "unavailable",
            f"{server['serverId']} was added by URL and has no computer; "
            "it can be used but not started, stopped or read from here.",
        )
    command = lifecycle_of(server).get(key)
    if not command:
        raise app_error(
            "invalid_argument",
            f"{server['serverId']} has neither a root nor a lifecycle.{key} override.",
        )
    return str(command)
