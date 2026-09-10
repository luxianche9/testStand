"""Literal port of the existing desktop SQLite/file startup migration."""

from __future__ import annotations

import shutil
import sqlite3
from contextlib import suppress
from pathlib import Path
from typing import Any, Protocol

from testforge_backend.compat import (
    UNDEFINED,
    clone,
    js_string,
    js_truthy,
    json_parse,
    new_uuid,
    utc_now_iso,
    utf8_bytes,
)
from testforge_backend.compat import filesystem as fs
from testforge_backend.contracts.devices import (
    parse_mcp_server,
    parse_remote_computer,
    parse_stored_hardware_definition,
)
from testforge_backend.devices import DeviceStore
from testforge_backend.storage import SecretStore, SettingsStore


class Protector(Protocol):
    def encrypt(self, value: str) -> bytes: ...
    def decrypt(self, value: bytes) -> str: ...


async def migrate_global_storage(user_data: str | Path, protector: Protector) -> bool:
    root = Path(user_data)
    settings_path, secrets_path = root / "settings.json", root / "secrets.json"
    if settings_path.exists() and secrets_path.exists():
        return False
    if settings_path.exists() != secrets_path.exists():
        raise RuntimeError(
            "Global storage is incomplete: settings.json and secrets.json must either "
            "both exist or both be absent"
        )
    database_path = next(
        (
            root / name
            for name in ("testforge-global-v2.db", "testforge.db")
            if (root / name).exists()
        ),
        None,
    )
    old_devices = root / "devices"
    if database_path is None and not old_devices.exists():
        return False
    stamp = utc_now_iso().replace(":", "-").replace(".", "-")
    backup = root / "backups" / f"storage-{stamp}"
    fs.mkdir(backup)
    if database_path is not None:
        _copy(database_path, backup / database_path.name)
    if old_devices.exists():
        _copy(old_devices, backup / "devices", recursive=True)
    stage = root / f".storage-migration-{new_uuid()}"
    devices = DeviceStore(stage / "devices")
    await devices.initialize()
    settings = SettingsStore(stage / "settings.json")
    await settings.initialize()
    secrets = SecretStore(stage / "secrets.json", protector)
    await secrets.initialize()
    database: sqlite3.Connection | None = None
    try:
        if database_path is not None:
            database = sqlite3.connect(database_path.resolve().as_uri() + "?mode=ro", uri=True)
        tables = (
            {
                row[0]
                for row in database.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            if database
            else set()
        )

        def db_setting(key: str) -> Any:
            if database is None or "settings" not in tables:
                return None
            row = database.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None

        theme = db_setting("theme")
        await settings.update(
            {"theme": theme if theme in ("light", "dark") else "system", "projectView": "wiring"}
        )
        computers = _computers(old_devices, database, tables)
        servers = _servers(old_devices, database, tables)
        if database is None and (computers or servers):
            raise RuntimeError("Legacy devices exist but their credential database is missing")
        owners: dict[str, str] = {}
        for value, _ in servers:
            owner = owners.get(value["hardwareId"])
            if owner and owner != value["serverId"]:
                raise RuntimeError(
                    f"Hardware {value['hardwareId']} is referenced by both "
                    f"{owner} and {value['serverId']}"
                )
            owners[value["hardwareId"]] = value["serverId"]
        for value, _ in computers:
            await devices.save_computer(value)
        await _copy_hardware(old_devices, devices)
        for value, _ in servers:
            await devices.save_server(value)
        if database is not None and "credentials" in tables:
            for value, key in computers:
                await _credential(database, protector, secrets, key, f"ssh:{value['id']}")
            for value, key in servers:
                await _credential(database, protector, secrets, key, f"mcp:{value['serverId']}")
            token_ref = db_setting("gateway.tokenRef")
            if js_truthy(token_ref):
                await _credential(database, protector, secrets, token_ref, "gateway")
        await secrets.flush()
        devices.list_computers()
        devices.list_servers()
        for hardware in devices.list_hardware():
            for asset in _assets(hardware):
                fs.stat(devices.image_path(hardware["hardwareId"], asset))
        displaced = root / f".devices-before-migration-{new_uuid()}"
        if old_devices.exists():
            fs.replace(old_devices, displaced)
        try:
            fs.replace(stage / "devices", old_devices)
            fs.replace(stage / "settings.json", settings_path)
            fs.replace(stage / "secrets.json", secrets_path)
            fs.rm(displaced, recursive=True, force=True)
        except Exception:
            fs.rm(old_devices, recursive=True, force=True)
            if displaced.exists():
                fs.replace(displaced, old_devices)
            raise
        return True
    finally:
        if database is not None:
            database.close()
        fs.rm(stage, recursive=True, force=True)


def _entries(directory: Path) -> list[Path]:
    return sorted(
        fs.scandir(directory), key=lambda path: path.name.encode("utf-16-be", "surrogatepass")
    )


def _copy(source: Path, destination: Path, *, recursive: bool = False) -> None:
    with fs.fs_operation("lstat", source):
        source.lstat()
    if source.is_symlink():
        with fs.fs_operation("readlink", source):
            link = source.readlink()
        if not link.is_absolute():
            link = source.parent / link
        if destination.is_symlink() or destination.exists():
            fs.unlink(destination)
        with fs.fs_operation("symlink", link, destination):
            destination.symlink_to(link.resolve(), target_is_directory=source.is_dir())
    elif source.is_dir():
        if not recursive:
            error = fs.NodeFsError("EISDIR", "cp", source)
            error.code = "ERR_FS_EISDIR"
            error.message = (
                f"Path is a directory: cp returned EISDIR "
                f"({source} is a directory (not copied)) {source}"
            )
            raise error
        fs.mkdir(destination)
        for child in _entries(source):
            _copy(child, destination / child.name, recursive=True)
    else:
        with fs.fs_operation("copyfile", source, destination):
            shutil.copyfile(source, destination)
        with fs.fs_operation("chmod", destination):
            shutil.copymode(source, destination)


def _documents(directory: Path, nested_name: str) -> list[Any]:
    if not directory.exists():
        return []
    output: list[Any] = []
    for entry in _entries(directory):
        if entry.is_symlink():
            continue
        path = (
            entry / nested_name
            if nested_name and entry.is_dir()
            else entry
            if not nested_name and entry.is_file() and entry.name.endswith(".json")
            else None
        )
        if path is None or not path.exists():
            continue
        with suppress(Exception):
            output.append(json_parse(fs.read_bytes(path).decode("utf-8", "replace")))
    return output


def _computers(
    root: Path, database: sqlite3.Connection | None, tables: set[str]
) -> list[tuple[dict[str, Any], str | None]]:
    raw = _documents(root / "computers", "")
    if database is not None and "computers" in tables:
        raw.extend(
            _legacy_json(row[0]) for row in database.execute("SELECT document FROM computers")
        )
    result: dict[str, tuple[dict[str, Any], str | None]] = {}
    for item in raw:
        if item is None:
            raise TypeError("Cannot read properties of null (reading 'ssh')")
        if not isinstance(item, dict):
            continue
        value = clone(item)
        ssh = value.get("ssh")
        key = ssh.pop("credentialRef", None) if isinstance(ssh, dict) else None
        try:
            parsed = parse_remote_computer(value)
            result[parsed["id"]] = (parsed, key if isinstance(key, str) else None)
        except Exception:
            pass
    return list(result.values())


def _servers(
    root: Path, database: sqlite3.Connection | None, tables: set[str]
) -> list[tuple[dict[str, Any], str | None]]:
    raw = _documents(root / "servers", "") + _documents(root / "servers", "server.json")
    if database is not None and "mcp_servers" in tables:
        raw.extend(
            _legacy_json(row[0]) for row in database.execute("SELECT document FROM mcp_servers")
        )
    result: dict[str, tuple[dict[str, Any], str | None]] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        value = clone(item)
        key = value.pop("credentialRef", None)
        try:
            parsed = parse_mcp_server(value)
            result[parsed["serverId"]] = (parsed, key if isinstance(key, str) else None)
        except Exception:
            pass
    return list(result.values())


def _legacy_json(value: Any) -> Any:
    # node:sqlite returns BLOBs as Uint8Array; JSON.parse coerces non-strings first.
    return json_parse(
        ",".join(str(byte) for byte in value) if isinstance(value, bytes) else js_string(value)
    )


def _assets(hardware: dict[str, Any]) -> list[str]:
    return [
        asset
        for asset in [
            hardware.get("appearanceAssetId"),
            *(port.get("imageAssetId") for port in hardware["ports"]),
        ]
        if isinstance(asset, str) and asset
    ]


async def _copy_hardware(root: Path, target: DeviceStore) -> None:
    directory = root / "hardware"
    if not directory.exists():
        return
    for entry in _entries(directory):
        source = entry / "hardware.json"
        if entry.is_symlink() or not entry.is_dir() or not source.exists():
            continue
        raw = json_parse(fs.read_bytes(source).decode("utf-8", "replace"))
        if raw is None:
            raise TypeError("Cannot read properties of null (reading 'hardwareId')")
        raw = raw if isinstance(raw, dict) else {}
        ports = raw.get("ports", UNDEFINED)
        hardware = {
            "formatVersion": 2,
            "hardwareId": raw.get("hardwareId", UNDEFINED),
            "label": raw.get("label", UNDEFINED),
            "ports": [] if ports is None or ports is UNDEFINED else ports,
        }
        if isinstance(raw.get("appearanceAssetId"), str):
            hardware["appearanceAssetId"] = raw["appearanceAssetId"]
        stored = parse_stored_hardware_definition(hardware)
        await target.save_hardware({**stored, "kind": "passive"})
        for asset in _assets(stored):
            source_asset = entry / asset
            fs.stat(source_asset)
            destination = Path(target.image_path(stored["hardwareId"], asset))
            fs.mkdir(destination.parent)
            _copy(source_asset, destination)


async def _credential(
    database: sqlite3.Connection,
    protector: Protector,
    target: SecretStore,
    old_key: Any,
    new_key: str,
) -> None:
    if not js_truthy(old_key):
        raise RuntimeError(f"Missing legacy credential reference for {new_key}")
    row = database.execute("SELECT encrypted FROM credentials WHERE ref = ?", (old_key,)).fetchone()
    if row is None or not js_truthy(row[0]):
        raise RuntimeError(f"Missing legacy credential {js_string(old_key)} for {new_key}")
    encrypted = row[0]
    if isinstance(encrypted, str):
        encrypted = utf8_bytes(encrypted)
    elif not isinstance(encrypted, bytes):
        raise TypeError(
            "The first argument must be of type string or an instance of Buffer, "
            "ArrayBuffer, or Array or an Array-like Object. "
            f"Received type number ({js_string(encrypted)})"
        )
    await target.set(new_key, json_parse(protector.decrypt(encrypted)))
