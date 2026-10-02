from __future__ import annotations

import asyncio
import contextlib
import errno
import io
import os
import shutil
import struct
import tempfile
import zipfile
import zlib
from collections.abc import Awaitable, Callable
from pathlib import Path, PureWindowsPath
from typing import Any
from urllib.parse import quote

from hardwareharness_backend.contracts.devices import (
    parse_adapter_record,
    parse_hardware,
    parse_mcp_server,
    parse_remote_computer,
    parse_stored_hardware_definition,
)
from hardwareharness_backend.storage import atomic_json
from hardwareharness_backend.util import (
    UNDEFINED,
    clone,
    json_dumps,
    json_loads,
    new_uuid,
    utc_now_iso,
)

Record = dict[str, Any]
Rename = Callable[[Path, Path], Awaitable[None]]
Remove = Callable[[Path], Awaitable[None]]

DEFINITION_DIR = "definition"
DEFINITION_FILE = "device.json"
DEFINITION_ASSETS = "assets"
ADAPTER_FILE = "adapter.json"


def _delete(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


async def _rename(source: Path, target: Path) -> None:
    os.replace(source, target)


async def _remove(path: Path) -> None:
    _delete(path)


def _write_bytes(path: Path, data: bytes | bytearray) -> None:
    if path.is_dir():
        raise IsADirectoryError(errno.EISDIR, "Is a directory", str(path))
    with path.open("wb") as stream:
        stream.write(data)


class DeviceStore:
    def __init__(
        self, root: str | Path, *, rename: Rename = _rename, remove: Remove = _remove
    ) -> None:
        self.root = Path(root).resolve()
        self._computer_dir = self.root / "computers"
        self._server_dir = self.root / "servers"
        self._hardware_dir = self.root / "hardware"
        self._rename = rename
        self._remove = remove
        self._read_cache: dict[str, tuple[str, list[Record]]] = {}

    async def initialize(self) -> None:
        for path in [self._computer_dir, self._server_dir, self._hardware_dir]:
            path.mkdir(parents=True, exist_ok=True)

    def list_computers(self) -> list[Record]:
        return sorted(
            self._read_all(self._computer_dir, "", parse_remote_computer),
            key=lambda item: item["id"],
        )

    def get_computer(self, identifier: str) -> Record | None:
        return next((item for item in self.list_computers() if item["id"] == identifier), None)

    async def save_computer(self, value: Record) -> Record:
        computer = parse_remote_computer(value)
        await atomic_json(self._computer_dir / (safe_segment(computer["id"]) + ".json"), computer)
        self._read_cache.clear()
        return computer

    async def remove_computer(self, identifier: str) -> list[str]:
        removed = []
        for server in self.list_servers():
            if server.get("computerId") == identifier:
                removed.append(str(server["serverId"]))
                await self.remove_server(server["serverId"])
        _delete(self._computer_dir / (safe_segment(identifier) + ".json"))
        self._read_cache.clear()
        return removed

    def list_servers(self) -> list[Record]:
        return sorted(
            self._read_all(self._server_dir, "", parse_mcp_server),
            key=lambda item: item["serverId"],
        )

    def get_server(self, server_id: str) -> Record | None:
        return next((item for item in self.list_servers() if item["serverId"] == server_id), None)

    async def save_server(self, value: Record) -> Record:
        server = parse_mcp_server(value)
        if "computerId" in server and not self.get_computer(server["computerId"]):
            raise RuntimeError(f"Remote computer not found: {server['computerId']}")
        for item in self.list_servers():
            if (
                item["hardwareId"] == server["hardwareId"]
                and item["serverId"] != server["serverId"]
            ):
                raise RuntimeError(
                    f"Hardware {server['hardwareId']} is already assigned to MCP "
                    f"server {item['serverId']}"
                )
        segment = safe_segment(server["serverId"])
        await atomic_json(self._server_dir / (segment + ".json"), server)
        self._read_cache.clear()
        if self.get_stored_hardware(server["hardwareId"]) is None:
            await self._save_stored_hardware(
                {
                    "formatVersion": 2,
                    "hardwareId": server["hardwareId"],
                    "label": server["hardwareId"],
                    "ports": [],
                }
            )
        return server

    async def remove_server(self, server_id: str) -> None:
        segment = safe_segment(server_id)
        await _remove(self._server_dir / (segment + ".json"))
        self._read_cache.clear()

    def list_stored_hardware(self) -> list[Record]:
        return sorted(
            self._read_all(self._hardware_dir, "hardware.json", _parse_stored),
            key=lambda item: item["hardwareId"],
        )

    def get_stored_hardware(self, hardware_id: str) -> Record | None:
        return next(
            (item for item in self.list_stored_hardware() if item["hardwareId"] == hardware_id),
            None,
        )

    def list_hardware(self) -> list[Record]:
        servers = {item["hardwareId"]: item for item in self.list_servers()}
        adapters = self.list_adapters()
        return [
            self._derive_hardware(item, servers, adapters) for item in self.list_stored_hardware()
        ]

    def list_adapters(self) -> dict[str, Record]:
        """Adapter release records (design doc 8.4) by hardwareId."""
        records = self._read_all(self._hardware_dir, ADAPTER_FILE, parse_adapter_record)
        return {item["hardwareId"]: item for item in records}

    def get_adapter(self, hardware_id: str) -> Record:
        return self.list_adapters().get(hardware_id) or parse_adapter_record(
            {"hardwareId": hardware_id}
        )

    async def save_adapter(self, record: Record) -> Record:
        parsed = parse_adapter_record(record)
        if self.get_stored_hardware(parsed["hardwareId"]) is None:
            raise RuntimeError(f"Unknown hardwareId: {parsed['hardwareId']}")
        await atomic_json(self._hardware_path(parsed["hardwareId"]) / ADAPTER_FILE, parsed)
        self._read_cache.clear()
        return parsed

    def get_hardware(self, hardware_id: str) -> Record | None:
        return next(
            (item for item in self.list_hardware() if item["hardwareId"] == hardware_id), None
        )

    def require_hardware(self, hardware_id: str) -> Record:
        hardware = self.get_hardware(hardware_id)
        if hardware is None:
            raise RuntimeError(f"Unknown hardwareId: {hardware_id}")
        return hardware

    async def save_hardware(self, value: Record) -> Record:
        parsed = parse_hardware(value)
        existing = self.get_stored_hardware(parsed["hardwareId"])
        stored = parse_stored_hardware_definition(
            {
                "formatVersion": 2,
                "hardwareId": parsed["hardwareId"],
                "label": parsed["label"],
                "ports": parsed["ports"],
                **(
                    {"appearanceAssetId": parsed["appearanceAssetId"]}
                    if parsed.get("appearanceAssetId")
                    else {}
                ),
            }
        )
        self._hardware_path(stored["hardwareId"]).mkdir(parents=True, exist_ok=True)
        keep = {port["imageAssetId"] for port in stored["ports"] if port.get("imageAssetId")}
        if existing:
            for port in existing["ports"]:
                if port.get("imageAssetId") and port["imageAssetId"] not in keep:
                    await self._delete_asset(stored["hardwareId"], port["imageAssetId"])
            if existing.get("appearanceAssetId") and existing["appearanceAssetId"] != stored.get(
                "appearanceAssetId"
            ):
                await self._delete_asset(stored["hardwareId"], existing["appearanceAssetId"])
        await self._save_stored_hardware(stored)
        return self._derive_hardware(stored)

    async def remove_hardware(self, hardware_id: str) -> None:
        server = next(
            (item for item in self.list_servers() if item["hardwareId"] == hardware_id), None
        )
        if server:
            raise RuntimeError(
                f"Hardware {hardware_id} is assigned to MCP server {server['serverId']}"
            )
        await _remove(self._hardware_path(hardware_id))
        self._read_cache.clear()

    async def put_image(self, hardware_id: str, port_id: str | None, source: str | Path) -> Record:
        return await self.put_image_bytes(
            hardware_id, port_id, Path(source).read_bytes(), image_extension(str(source))
        )

    async def put_image_bytes(
        self,
        hardware_id: str,
        port_id: str | None,
        data: bytes | bytearray,
        extension_hint: str = "",
    ) -> Record:
        self._require_editable_images(hardware_id)
        hardware = self.require_hardware(hardware_id)
        if port_id is not None and not any(p["portId"] == port_id for p in hardware["ports"]):
            raise RuntimeError(f"Unknown portId: {port_id}")
        if not data or len(data) > 10 * 1024 * 1024:
            raise RuntimeError("Image must be between 1 byte and 10 MB")
        extension = resolve_image_extension(data, extension_hint)
        asset_id = (
            f"appearance{extension}"
            if port_id is None
            else f"ports/{safe_segment(port_id)}{extension}"
        )
        target = self.image_path(hardware_id, asset_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_bytes(target, data)
        target_record = (
            hardware
            if port_id is None
            else next(p for p in hardware["ports"] if p["portId"] == port_id)
        )
        field = "appearanceAssetId" if port_id is None else "imageAssetId"
        previous = target_record.get(field)
        if previous and previous != asset_id:
            await self._delete_asset(hardware_id, previous)
        target_record[field] = asset_id
        return await self.save_hardware(hardware)

    async def remove_image(self, hardware_id: str, port_id: str | None = None) -> Record:
        self._require_editable_images(hardware_id)
        hardware = self.require_hardware(hardware_id)
        target = (
            hardware
            if port_id is None
            else next((port for port in hardware["ports"] if port["portId"] == port_id), {})
        )
        field = "appearanceAssetId" if port_id is None else "imageAssetId"
        previous = target.pop(field, None)
        if previous:
            await self._delete_asset(hardware_id, previous)
        return await self.save_hardware(hardware)

    def image_path(self, hardware_id: str, asset_id: str) -> Path:
        return _resolve_inside(self._hardware_path(hardware_id), asset_id)

    # -- server-provided definitions (design doc §9.7) ---------------------------------------

    def get_definition(self, hardware_id: str) -> Record | None:
        """``{document, fetchedAt}``: the last ``/device`` seen for a managed device."""
        path = self._hardware_path(hardware_id) / DEFINITION_DIR / DEFINITION_FILE
        with contextlib.suppress(OSError, ValueError):
            value = json_loads(path.read_bytes().decode("utf-8"))
            if isinstance(value, dict) and isinstance(value.get("document"), dict):
                return value
        return None

    async def save_definition(
        self, hardware_id: str, document: Record, assets: dict[str, bytes]
    ) -> Record:
        """Replace the cached declaration and its assets (staged, then swapped in)."""
        directory = self._hardware_path(hardware_id)
        directory.mkdir(parents=True, exist_ok=True)
        staging = directory / f"{DEFINITION_DIR}.{new_uuid()}.tmp"
        try:
            for path, content in assets.items():
                target = _resolve_inside(staging / DEFINITION_ASSETS, path)
                target.parent.mkdir(parents=True, exist_ok=True)
                _write_bytes(target, content)
            value = {"document": document, "fetchedAt": utc_now_iso()}
            await atomic_json(staging / DEFINITION_FILE, value)
            await self._remove(directory / DEFINITION_DIR)
            await self._rename(staging, directory / DEFINITION_DIR)
        finally:
            with contextlib.suppress(OSError):
                _delete(staging)
        return value

    def definition_asset_id(self, path: str) -> str:
        """The ``hardwareharness-asset:`` asset id of a cached ``/assets`` file."""
        return f"{DEFINITION_DIR}/{DEFINITION_ASSETS}/{path.lstrip('/')}"

    def _require_editable_images(self, hardware_id: str) -> None:
        if self.get_definition(hardware_id) is not None:
            raise RuntimeError(
                f"Hardware {hardware_id} takes its pictures and pinout from its MCP server; "
                "they are read-only here"
            )

    async def export_bundle(self, identifier: str) -> bytes:
        hardware = self.get_stored_hardware(identifier)
        if hardware is None:
            raise RuntimeError(f"Unknown hardwareId: {identifier}")
        entries = {
            "hardware.json": _encode_json(hardware),
            "bundle.json": _encode_json(
                {
                    "formatVersion": 2,
                    "kind": "hardware",
                    "id": identifier,
                    "exportedAt": utc_now_iso(),
                }
            ),
        }
        for asset_id in _asset_ids(hardware):
            with contextlib.suppress(OSError):
                entries[asset_id] = self.image_path(identifier, asset_id).read_bytes()
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        return output.getvalue()

    async def inspect_bundle(self, data: bytes) -> Record:
        return (await asyncio.to_thread(_parse_bundle, data))[1]

    async def import_bundle(self, data: bytes, options: Record | None = None) -> Record:
        options = options or {}
        entries, stored, assets = await asyncio.to_thread(_parse_bundle, data)
        expected = options.get("expectedHardwareId")
        if expected and expected != stored["hardwareId"]:
            raise RuntimeError(
                f"Bundle hardwareId {stored['hardwareId']} does not match expected "
                f"hardwareId {expected}"
            )
        replaced = self.get_stored_hardware(stored["hardwareId"]) is not None
        assigned = next(
            (s for s in self.list_servers() if s["hardwareId"] == stored["hardwareId"]), None
        )
        if replaced and assigned and assigned["serverId"] != options.get("allowManagedServerId"):
            raise RuntimeError(f"Cannot replace managed hardware {stored['hardwareId']}")
        staging_root = Path(tempfile.mkdtemp(prefix=".import-", dir=self._hardware_dir))
        staging = staging_root / "hardware"
        target = self._hardware_path(stored["hardwareId"])
        backup = target.with_name(target.name + ".backup-" + new_uuid())
        existing_moved = staging_moved = False
        try:
            staging.mkdir(parents=True, exist_ok=True)
            for asset_id in assets:
                asset = _resolve_inside(staging, asset_id)
                asset.parent.mkdir(parents=True, exist_ok=True)
                _write_bytes(asset, entries[asset_id])
            await atomic_json(staging / "hardware.json", stored)
            if target.exists():
                await self._rename(target, backup)
                existing_moved = True
            await self._rename(staging, target)
            staging_moved = True
            if existing_moved:
                await self._remove(backup)
                existing_moved = False
        except Exception as error:
            if staging_moved:
                with contextlib.suppress(OSError):
                    await self._remove(target)
            if existing_moved:
                try:
                    await self._rename(backup, target)
                except Exception as restore_error:
                    raise ExceptionGroup(
                        "Hardware bundle replacement failed and automatic "
                        f"rollback failed; backup preserved at {backup}",
                        [error, restore_error],
                    ) from error
            raise
        finally:
            with contextlib.suppress(OSError):
                _delete(staging_root)
        self._read_cache.clear()
        return {"id": stored["hardwareId"], "label": stored["label"], "replaced": replaced}

    def _derive_hardware(
        self,
        stored: Record,
        servers: dict[str, Record] | None = None,
        adapters: dict[str, Record] | None = None,
    ) -> Record:
        server = (
            servers.get(stored["hardwareId"])
            if servers is not None
            else next(
                (s for s in self.list_servers() if s["hardwareId"] == stored["hardwareId"]), None
            )
        )
        adapter = (adapters if adapters is not None else self.list_adapters()).get(
            stored["hardwareId"]
        )
        return parse_hardware(
            {
                **stored,
                "kind": "managed" if server else "passive",
                **(
                    {
                        "serverId": server["serverId"],
                        **({"computerId": server["computerId"]} if "computerId" in server else {}),
                        "adapterStatus": adapter["status"] if adapter else "developing",
                    }
                    if server
                    else {}
                ),
            }
        )

    async def _save_stored_hardware(self, stored: Record) -> None:
        parsed = parse_stored_hardware_definition(stored)
        directory = self._hardware_path(parsed["hardwareId"])
        directory.mkdir(parents=True, exist_ok=True)
        await atomic_json(directory / "hardware.json", parsed)
        self._read_cache.clear()

    def _hardware_path(self, hardware_id: str) -> Path:
        return self._hardware_dir / safe_segment(hardware_id)

    async def _delete_asset(self, hardware_id: str, asset_id: str) -> None:
        target = self.image_path(hardware_id, asset_id)
        with contextlib.suppress(OSError):
            _delete(target)

    def _read_all(
        self, directory: Path, document_name: str, parse: Callable[[Any], Record]
    ) -> list[Record]:
        try:
            entries = list(directory.iterdir())
        except OSError:
            return []
        paths = sorted(
            [entry / document_name for entry in entries if entry.is_dir()]
            if document_name
            else [entry for entry in entries if entry.is_file() and entry.name.endswith(".json")]
        )
        signatures = []
        for path in paths:
            try:
                stat = path.stat()
                signatures.append(f"{path}:{stat.st_mtime_ns}:{stat.st_size}")
            except OSError:
                signatures.append(f"{path}:missing")
        signature = "|".join(signatures)
        key = f"{directory}\0{document_name}"
        cached = self._read_cache.get(key)
        if cached and cached[0] == signature:
            return clone(cached[1])
        output = []
        for path in paths:
            with contextlib.suppress(Exception):
                output.append(
                    parse(json_loads(path.read_bytes().decode("utf-8", errors="replace")))
                )
        self._read_cache[key] = (signature, clone(output))
        return output


def safe_segment(value: str) -> str:
    if not value.strip():
        raise RuntimeError(f"Identifier cannot be used as a file name: {value}")
    encoded = quote(value, safe="-_.~")
    return encoded.replace(".", "%2E") if encoded in {".", ".."} else encoded


def _parse_stored(value: Any) -> Record:
    if value is None:
        raise TypeError("Cannot read properties of null (reading 'hardwareId')")
    raw = value if isinstance(value, dict) else {}
    return parse_stored_hardware_definition(
        {
            "formatVersion": 2,
            "hardwareId": raw.get("hardwareId", UNDEFINED),
            "label": raw.get("label", UNDEFINED),
            "ports": raw.get("ports") if raw.get("ports") is not None else [],
            **(
                {"appearanceAssetId": raw["appearanceAssetId"]}
                if isinstance(raw.get("appearanceAssetId"), str)
                else {}
            ),
        }
    )


def _asset_ids(hardware: Record) -> list[str]:
    return [
        value
        for value in [
            hardware.get("appearanceAssetId"),
            *[p.get("imageAssetId") for p in hardware["ports"]],
        ]
        if isinstance(value, str)
    ]


def _encode_json(value: Any) -> bytes:
    return (json_dumps(value, indent=2) + "\n").encode("utf-8")


def image_extension(source: str) -> str:
    extension = PureWindowsPath(source).suffix.lower()
    if not extension:
        extension = source.lower() if source.startswith(".") else "." + source.lower()
    return ".jpg" if extension == ".jpeg" else extension


def resolve_image_extension(data: bytes | bytearray, hint: str) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        detected = ".png"
    elif data.startswith(b"\xff\xd8\xff"):
        detected = ".jpg"
    elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        detected = ".webp"
    else:
        raise RuntimeError("Only PNG, JPEG and WebP images are supported")
    extension = image_extension(hint) if hint.strip() else detected
    if extension in {".png", ".jpg", ".webp"} and extension != detected:
        raise RuntimeError("Image content does not match its extension")
    return detected


def _resolve_inside(root: Path, relative: str) -> Path:
    if PureWindowsPath(relative).drive:
        raise RuntimeError(f"Unsafe asset path {relative}")
    target = (root / relative.replace("\\", "/")).resolve()
    if target == root or not target.is_relative_to(root):
        raise RuntimeError(f"Unsafe asset path {relative}")
    return target


def _parse_bundle(data: bytes) -> tuple[dict[str, bytes], Record, list[str]]:
    if len(data) > 64 * 1024 * 1024:
        raise RuntimeError("Bundle exceeds the 64 MB archive limit")
    entries: dict[str, bytes] = {}
    expanded = 0
    # fflate.Unzip reads local records and does not require a central directory or CRC.
    # Preserve that behavior instead of zipfile's stricter archive validation.
    offset = 0
    while (offset := data.find(b"PK\x03\x04", offset)) >= 0 and offset + 30 <= len(data):
        _, _, flags, method, _, _, _, compressed_size, size, name_size, extra_size = (
            struct.unpack_from("<I5H3I2H", data, offset)
        )
        start = offset + 30 + name_size + extra_size
        if start > len(data):
            break
        filename = data[offset + 30 : offset + 30 + name_size].decode(
            "utf-8" if flags & 0x800 else "latin1", errors="replace"
        )
        name = filename.replace("\\", "/")
        if (
            not name
            or name.startswith("/")
            or PureWindowsPath(name).drive
            or any(part in {"..", ""} for part in name.split("/"))
        ):
            raise RuntimeError(f"Unsafe bundle entry {filename}")
        if len(entries) >= 128:
            raise RuntimeError("Bundle exceeds the 128-entry limit")
        if name in entries:
            raise RuntimeError(f"Bundle contains duplicate entry {name}")
        if size == 0xFFFFFFFF or compressed_size == 0xFFFFFFFF:
            extra = data[offset + 30 + name_size : start]
            cursor = 0
            while cursor + 4 <= len(extra):
                kind, length = struct.unpack_from("<HH", extra, cursor)
                cursor += 4
                if kind == 1 and length >= 16:
                    size, compressed_size = struct.unpack_from("<QQ", extra, cursor)
                    break
                cursor += length
        if not flags & 8 and size > 32 * 1024 * 1024:
            raise RuntimeError(f"Bundle entry {name} exceeds the 32 MB limit")
        if method not in {0, 8}:
            raise RuntimeError(f"unknown compression type {method}")
        end = start + compressed_size
        if flags & 8:
            end = data.find(b"PK\x07\x08", start)
            if end < 0:
                end = data.find(b"PK\x01\x02", start)
            if end < 0:
                end = len(data)
        compressed = data[start:end]
        if method == 0:
            content = compressed
        else:
            inflater = zlib.decompressobj(-15)
            try:
                content = inflater.decompress(compressed, 32 * 1024 * 1024 + 1)
            except zlib.error as error:
                message = str(error)
                raise RuntimeError(
                    "invalid distance"
                    if "distance" in message
                    else "invalid block type"
                    if "block type" in message
                    else "invalid length/literal"
                ) from error
        if len(content) > 32 * 1024 * 1024:
            raise RuntimeError(f"Bundle entry {name} exceeds the 32 MB limit")
        expanded += len(content)
        if expanded > 256 * 1024 * 1024:
            raise RuntimeError("Bundle exceeds the 256 MB expanded-size limit")
        entries[name] = content
        offset = max(end, start)

    def decode_document(name: str) -> Any:
        if name not in entries:
            raise RuntimeError(f"Bundle is missing {name}")
        if len(entries[name]) > 1024 * 1024:
            raise RuntimeError(f"{name} exceeds the 1 MB limit")
        return json_loads(entries[name].decode("utf-8-sig", errors="replace"))

    manifest = decode_document("bundle.json")
    if manifest is None:
        raise TypeError("Cannot read properties of null (reading 'formatVersion')")
    if not isinstance(manifest, dict):
        manifest = {}
    if manifest.get("formatVersion") != 2 or manifest.get("kind") != "hardware":
        raise RuntimeError("Only formatVersion 2 hardware bundles are supported")
    stored = _parse_stored(decode_document("hardware.json"))
    if manifest.get("id") != stored["hardwareId"]:
        raise RuntimeError("Bundle manifest id does not match hardware.json")
    assets = _asset_ids(stored)
    allowed = {"bundle.json", "hardware.json", *assets}
    for name in entries:
        if name not in allowed:
            raise RuntimeError(f"Bundle contains unexpected entry {name}")
    for asset_id in assets:
        if asset_id not in entries:
            raise RuntimeError(f"Bundle is missing image {asset_id}")
        resolve_image_extension(entries[asset_id], asset_id)
    return entries, stored, assets
