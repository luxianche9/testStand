from __future__ import annotations

import asyncio
import contextlib
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

from teststand_backend.contracts.devices import (
    parse_device_instance,
    parse_hardware,
    parse_stored_hardware_definition,
)
from teststand_backend.storage import atomic_json
from teststand_backend.util import (
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


def _delete(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


async def _rename(source: Path, target: Path) -> None:
    os.replace(source, target)


async def _remove(path: Path) -> None:
    _delete(path)


class DeviceStore:
    def __init__(
        self, root: str | Path, *, rename: Rename = _rename, remove: Remove = _remove
    ) -> None:
        self.root = Path(root).resolve()
        self._device_dir = self.root / "devices"
        self._hardware_dir = self.root / "hardware"
        self._rename = rename
        self._remove = remove
        self._read_cache: dict[str, tuple[str, list[Record]]] = {}
        self._notifier: Callable[[], None] | None = None

    def set_notifier(self, notifier: Callable[[], None]) -> None:
        """Called after every write, so views of the catalog can refetch."""
        self._notifier = notifier

    async def initialize(self) -> None:
        for path in [self._device_dir, self._hardware_dir]:
            path.mkdir(parents=True, exist_ok=True)

    def list_devices(self) -> list[Record]:
        return sorted(
            self._read_all(self._device_dir, "", parse_device_instance),
            key=lambda item: item["deviceId"],
        )

    def get_device(self, device_id: str) -> Record | None:
        return next((item for item in self.list_devices() if item["deviceId"] == device_id), None)

    async def save_device(self, value: Record) -> Record:
        instance = parse_device_instance(value)
        for item in self.list_devices():
            if (
                item["hardwareId"] == instance["hardwareId"]
                and item["deviceId"] != instance["deviceId"]
            ):
                raise RuntimeError(
                    f"Hardware {instance['hardwareId']} is already assigned to "
                    f"device {item['deviceId']}"
                )
        segment = safe_segment(instance["deviceId"])
        await atomic_json(self._device_dir / (segment + ".json"), instance)
        self._changed()
        # The device's hardware record carries its name; ports come from the plugin on connect.
        current = self.get_stored_hardware(instance["hardwareId"])
        if current is None or current["label"] != instance["label"]:
            await self._save_stored_hardware(
                {
                    "formatVersion": 2,
                    "hardwareId": instance["hardwareId"],
                    "label": instance["label"],
                    "ports": current["ports"] if current else [],
                }
            )
        return instance

    async def remove_device(self, device_id: str) -> None:
        """Remove a device and its hardware record: a device's ports come from its plugin, so
        nothing of it is left behind as a stray passive part."""
        instance = self.get_device(device_id)
        segment = safe_segment(device_id)
        await _remove(self._device_dir / (segment + ".json"))
        if instance is not None:
            await _remove(self._hardware_path(instance["hardwareId"]))
        self._changed()

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
        instances = {item["hardwareId"]: item for item in self.list_devices()}
        return [self._derive_hardware(item, instances) for item in self.list_stored_hardware()]

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
        stored = parse_stored_hardware_definition(
            {
                "formatVersion": 2,
                "hardwareId": parsed["hardwareId"],
                "label": parsed["label"],
                "ports": parsed["ports"],
                "signals": parsed["signals"],
            }
        )
        await self._save_stored_hardware(stored)
        return self._derive_hardware(stored)

    async def sync_managed_hardware(
        self, hardware_id: str, label: str, ports: list[Record]
    ) -> None:
        """Keep a managed device's hardware record in step with its plugin: ports are replaced by
        the declared pinout. The label follows the device's name (set by ``save_device``)."""
        current = self.get_stored_hardware(hardware_id)
        stored = parse_stored_hardware_definition(
            {
                "formatVersion": 2,
                "hardwareId": hardware_id,
                "label": current["label"] if current else label,
                "ports": ports,
            }
        )
        if current is None or current.get("ports") != stored["ports"]:
            await self._save_stored_hardware(stored)

    async def remove_hardware(self, hardware_id: str) -> None:
        instance = next(
            (item for item in self.list_devices() if item["hardwareId"] == hardware_id), None
        )
        if instance:
            raise RuntimeError(
                f"Hardware {hardware_id} is assigned to device {instance['deviceId']}"
            )
        await _remove(self._hardware_path(hardware_id))
        self._changed()

    # -- plugin-provided definitions (design doc §9.7) ---------------------------------------

    def get_definition(self, hardware_id: str) -> Record | None:
        """``{document, fetchedAt}``: the last ``/device`` seen for a managed device."""
        path = self._hardware_path(hardware_id) / DEFINITION_DIR / DEFINITION_FILE
        with contextlib.suppress(OSError, ValueError):
            value = json_loads(path.read_bytes().decode("utf-8"))
            if isinstance(value, dict) and isinstance(value.get("document"), dict):
                return value
        return None

    async def save_definition(self, hardware_id: str, document: Record) -> Record:
        """Replace the cached declaration (staged, then swapped in)."""
        directory = self._hardware_path(hardware_id)
        directory.mkdir(parents=True, exist_ok=True)
        staging = directory / f"{DEFINITION_DIR}.{new_uuid()}.tmp"
        try:
            value = {"document": document, "fetchedAt": utc_now_iso()}
            await atomic_json(staging / DEFINITION_FILE, value)
            await self._remove(directory / DEFINITION_DIR)
            await self._rename(staging, directory / DEFINITION_DIR)
        finally:
            with contextlib.suppress(OSError):
                _delete(staging)
        self._changed()
        return value

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
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        return output.getvalue()

    async def inspect_bundle(self, data: bytes) -> Record:
        return await asyncio.to_thread(_parse_bundle, data)

    async def import_bundle(self, data: bytes) -> Record:
        """Import a passive hardware definition (``.tshw``); devices get ports from their plugin."""
        stored = await asyncio.to_thread(_parse_bundle, data)
        replaced = self.get_stored_hardware(stored["hardwareId"]) is not None
        if any(item["hardwareId"] == stored["hardwareId"] for item in self.list_devices()):
            raise RuntimeError(
                f"Hardware {stored['hardwareId']} belongs to a device; "
                "its ports come from the plugin"
            )
        staging_root = Path(tempfile.mkdtemp(prefix=".import-", dir=self._hardware_dir))
        staging = staging_root / "hardware"
        target = self._hardware_path(stored["hardwareId"])
        backup = target.with_name(target.name + ".backup-" + new_uuid())
        existing_moved = staging_moved = False
        try:
            staging.mkdir(parents=True, exist_ok=True)
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
        self._changed()
        return {"id": stored["hardwareId"], "label": stored["label"], "replaced": replaced}

    def _derive_hardware(
        self,
        stored: Record,
        instances: dict[str, Record] | None = None,
    ) -> Record:
        instance = (
            instances.get(stored["hardwareId"])
            if instances is not None
            else next(
                (s for s in self.list_devices() if s["hardwareId"] == stored["hardwareId"]), None
            )
        )
        return parse_hardware(
            {
                **stored,
                "kind": "managed" if instance else "passive",
                **({"deviceId": instance["deviceId"]} if instance else {}),
            }
        )

    async def _save_stored_hardware(self, stored: Record) -> None:
        parsed = parse_stored_hardware_definition(stored)
        directory = self._hardware_path(parsed["hardwareId"])
        directory.mkdir(parents=True, exist_ok=True)
        await atomic_json(directory / "hardware.json", parsed)
        self._changed()

    def changed(self) -> None:
        """Tell subscribers the device data changed (also used when device types change)."""
        self._changed()

    def _changed(self) -> None:
        self._read_cache.clear()
        if self._notifier is not None:
            self._notifier()

    def _hardware_path(self, hardware_id: str) -> Path:
        return self._hardware_dir / safe_segment(hardware_id)

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
            "signals": raw.get("signals") if raw.get("signals") is not None else [],
        }
    )


def _encode_json(value: Any) -> bytes:
    return (json_dumps(value, indent=2) + "\n").encode("utf-8")


def _parse_bundle(data: bytes) -> Record:
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
    for name in entries:
        if name not in {"bundle.json", "hardware.json"}:
            raise RuntimeError(f"Bundle contains unexpected entry {name}")
    return stored
