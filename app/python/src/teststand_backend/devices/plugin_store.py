"""Installed device packages (``.tsdev``): a device type delivered as a file, not with the app.

A package is a ZIP with ``package.json`` (the manifest the user confirms before installing) and
``wheels/*.whl``: the adapter's wheel plus any third-party wheels it needs. Installing unpacks
every wheel into ``<root>/<type>/<dir>/site`` (an unpacked wheel is a valid ``sys.path`` entry
whose ``*.dist-info`` carries the ``teststand.devices`` entry point) and records it in
``installed.json``. :func:`teststand_device_sdk.activate_plugins` reads that file in the
backend and in every isolated child.

Users never see "types": adding a device installs its package when needed and removing the
last device of a package uninstalls it.

A brand-new type is usable at once. Replacing or removing a type the backend may already have
imported only takes effect at the next start: the change is kept under ``pending`` and applied
by :meth:`PluginStore.initialize` before anything is imported.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import re
import shutil
import tempfile
import zipfile
from importlib.metadata import PackageNotFoundError, distribution, entry_points
from pathlib import Path, PurePosixPath
from typing import Any

from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.utils import canonicalize_name
from teststand_device_sdk import (
    ENTRY_POINT_GROUP,
    INSTALLED_FILE,
    PLUGINS_ENV,
    activate_plugins,
)
from teststand_device_sdk import (
    __version__ as SDK_VERSION,
)

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.validation import (
    ValidationError,
    array,
    enum,
    literal,
    obj,
    parse_record,
    record,
    string,
)
from teststand_backend.storage.file_storage import atomic_json
from teststand_backend.util import json_loads, utc_now_iso

Record = dict[str, Any]

PACKAGE_EXTENSION = ".tsdev"
MANIFEST = "package.json"
MAX_ARCHIVE = 48 * 1024 * 1024  # sent base64 in a JSON body of at most 64 MB
MAX_EXPANDED = 256 * 1024 * 1024
MAX_ENTRIES = 64
MAX_MANIFEST = 256 * 1024
SDK_DISTRIBUTION = "teststand-device-sdk"
PYTHON_TAGS = {"py3", "cp311", "py311"}
ABI_TAGS = {"none", "abi3", "cp311"}
PLATFORM_TAGS = {"any", "win_amd64"}
TYPE_REGEX = r"^[a-z][a-z0-9_]{0,63}$"

manifest_schema = obj(
    {
        "formatVersion": literal(1),
        "kind": literal("devicePlugin"),
        "type": string(regex=TYPE_REGEX),
        "distribution": string(1, 200),
        "version": string(1, 64, regex=r"^[0-9A-Za-z.+!_-]+$"),
        "manufacturer": string(1, 200),
        "model": string(1, 200),
        "isolation": enum("inproc", "subprocess"),
        "description": string(maximum=4000).default(""),
        "sdk": string(1, 100),
        "vendorDrivers": array(string(1, 200), maximum=16).default([]),
        "files": record(string(regex=r"^[0-9a-f]{64}$")),
        "builtAt": string(datetime=True, offset=True).optional(),
    },
    strict=True,
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        not name
        or name.startswith(("/", "\\"))
        or "\\" in name
        or ".." in path.parts
        or ":" in name
    ):
        raise app_error("invalid_argument", f"Unsafe path in package: {name}")
    return path


def _wheel_tags(name: str) -> tuple[str, str, str, str]:
    """``(distribution, python, abi, platform)`` from a wheel file name."""
    parts = name[: -len(".whl")].split("-")
    if len(parts) not in (5, 6):
        raise app_error("invalid_argument", f"Not a wheel file name: {name}")
    return parts[0], parts[-3], parts[-2], parts[-1]


def _compatible(name: str) -> bool:
    _, python, abi, platform = _wheel_tags(name)
    return (
        bool(set(python.split(".")) & PYTHON_TAGS)
        and bool(set(abi.split(".")) & ABI_TAGS)
        and bool(set(platform.split(".")) & PLATFORM_TAGS)
    )


def _read_archive(data: bytes) -> tuple[Record, dict[str, bytes]]:
    """The validated manifest and the wheels (file name -> bytes) of a ``.tsdev`` archive."""
    if len(data) > MAX_ARCHIVE:
        raise app_error("invalid_argument", "Device package exceeds the 48 MB limit")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise app_error(
            "invalid_argument", "Not a device package (.tsdev is a ZIP file)"
        ) from error
    with archive:
        items = archive.infolist()
        if len(items) > MAX_ENTRIES:
            raise app_error(
                "invalid_argument", f"Device package has more than {MAX_ENTRIES} entries"
            )
        if sum(item.file_size for item in items) > MAX_EXPANDED:
            raise app_error("invalid_argument", "Device package expands beyond 256 MB")
        manifest: Any = None
        wheels: dict[str, bytes] = {}
        for item in items:
            if item.is_dir():
                continue
            path = _safe_name(item.filename)
            if path.as_posix() == MANIFEST:
                if item.file_size > MAX_MANIFEST:
                    raise app_error("invalid_argument", "package.json is too large")
                manifest = json_loads(archive.read(item))
            elif len(path.parts) == 2 and path.parts[0] == "wheels" and path.suffix == ".whl":
                wheels[path.name] = archive.read(item)
            else:
                raise app_error(
                    "invalid_argument", f"Unexpected entry in device package: {item.filename}"
                )
    if manifest is None:
        raise app_error("invalid_argument", "Device package has no package.json")
    try:
        parsed = parse_record(manifest_schema, manifest)
    except ValidationError as error:
        raise app_error("invalid_argument", f"Invalid package.json: {error}") from error
    if set(parsed["files"]) != set(wheels):
        raise app_error(
            "invalid_argument", "package.json files do not match the wheels in the package"
        )
    for name, content in wheels.items():
        if _sha256(content) != parsed["files"][name]:
            raise app_error("invalid_argument", f"SHA-256 mismatch for {name}")
    return parsed, wheels


def _wheel_metadata(content: bytes) -> tuple[str, list[str], dict[str, str]]:
    """``(distribution name, Requires-Dist, teststand.devices entry points)`` of a wheel."""
    with zipfile.ZipFile(io.BytesIO(content)) as wheel:
        names = wheel.namelist()
        info = next((n for n in names if re.fullmatch(r"[^/]+\.dist-info/METADATA", n)), None)
        if info is None:
            raise app_error("invalid_argument", "Wheel has no METADATA")
        prefix = info.rsplit("/", 1)[0]
        metadata = wheel.read(info).decode("utf-8", "replace")
        points_name = f"{prefix}/entry_points.txt"
        points = wheel.read(points_name).decode("utf-8") if points_name in names else ""
    name = next(
        (line[5:].strip() for line in metadata.splitlines() if line.startswith("Name:")), ""
    )
    requires = [
        line[len("Requires-Dist:") :].strip()
        for line in metadata.splitlines()
        if line.startswith("Requires-Dist:")
    ]
    devices: dict[str, str] = {}
    group = None
    for line in points.splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            group = line[1:-1].strip()
        elif group == ENTRY_POINT_GROUP and "=" in line:
            key, _, value = line.partition("=")
            devices[key.strip()] = value.strip()
    return name, requires, devices


def _extract_wheel(content: bytes, site: Path) -> None:
    """Unpack a wheel like an installer does for purelib/platlib; other schemes are refused."""
    with zipfile.ZipFile(io.BytesIO(content)) as wheel:
        for item in wheel.infolist():
            if item.is_dir():
                continue
            path = _safe_name(item.filename)
            first = path.parts[0]
            if first.endswith(".data"):
                if len(path.parts) < 3 or path.parts[1] not in ("purelib", "platlib"):
                    raise app_error(
                        "invalid_argument", f"Wheel installs outside the package: {item.filename}"
                    )
                path = PurePosixPath(*path.parts[2:])
            target = site.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(wheel.read(item))


def _is_under(path: Path, root: Path) -> bool:
    try:
        return path.resolve().is_relative_to(root.resolve())
    except OSError:
        return False


def _remove(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


class PluginStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.state: Record = {"formatVersion": 1, "types": {}, "pending": {}}
        self._lock = asyncio.Lock()

    @property
    def _state_file(self) -> Path:
        return self.root / INSTALLED_FILE

    async def initialize(self) -> None:
        """Apply changes left pending by the previous run, then put every package on the path."""
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            loaded = json_loads(self._state_file.read_bytes())
        except FileNotFoundError:
            loaded = {}
        if isinstance(loaded, dict):
            self.state["types"] = dict(loaded.get("types") or {})
            self.state["pending"] = dict(loaded.get("pending") or {})
        for name, change in list(self.state["pending"].items()):
            if change.get("action") == "uninstall":
                self.state["types"].pop(name, None)
            elif change.get("action") == "install":
                self.state["types"][name] = change["entry"]
        self.state["pending"] = {}
        await atomic_json(self._state_file, self.state)
        self._prune()
        os.environ[PLUGINS_ENV] = str(self.root)
        activate_plugins(self.root)

    def _prune(self) -> None:
        """Delete package directories no record refers to (old versions, abandoned staging)."""
        keep: dict[str, set[str]] = {}
        for name, entry in self.state["types"].items():
            keep.setdefault(name, set()).add(entry["dir"])
        for name, change in self.state["pending"].items():
            if change.get("action") == "install":
                keep.setdefault(name, set()).add(change["entry"]["dir"])
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            if child.name not in keep:
                _remove(child)
                continue
            for version in child.iterdir():
                if version.is_dir() and version.name not in keep[child.name]:
                    _remove(version)

    def list_packages(self) -> list[Record]:
        output = []
        for name in sorted(set(self.state["types"]) | set(self.state["pending"])):
            entry = self.state["types"].get(name)
            change = self.state["pending"].get(name)
            item: Record = {"type": name, **(entry or change["entry"])}
            item.pop("dir", None)
            item["active"] = entry is not None
            if change:
                item["pending"] = (
                    {"action": "uninstall"}
                    if change["action"] == "uninstall"
                    else {"action": "install", "version": change["entry"]["version"]}
                )
            output.append(item)
        return output

    def _builtin_owner(self, device_type: str) -> str | None:
        """The distribution outside the package store that already provides ``device_type``."""
        for item in entry_points(group=ENTRY_POINT_GROUP):
            if item.name != device_type or item.dist is None:
                continue
            location = Path(str(item.dist.locate_file("")))
            if not _is_under(location, self.root):
                return str(item.dist.metadata["Name"])
        return None

    def _shipped(self, key: str) -> str | None:
        """Version of distribution ``key`` when testStand itself ships it (outside the store)."""
        try:
            found = distribution(key)
        except PackageNotFoundError:
            return None
        if _is_under(Path(str(found.locate_file(""))), self.root):
            return None
        return str(found.version)

    def _check(self, manifest: Record, wheels: dict[str, bytes]) -> tuple[list[str], set[str]]:
        """Reasons the package cannot be installed here (empty when it can), and the dependency
        wheels to leave out because testStand already ships that distribution."""
        problems: list[str] = []
        skipped: set[str] = set()
        provided: dict[str, str] = {}
        adapter: tuple[str, list[str], dict[str, str]] | None = None
        for name, content in sorted(wheels.items()):
            if not _compatible(name):
                problems.append(f"{name} is not built for CPython 3.11 on 64-bit Windows")
            try:
                dist, requires, devices = _wheel_metadata(content)
            except (zipfile.BadZipFile, KeyError) as error:
                problems.append(f"{name} is not a valid wheel: {error}")
                continue
            provided[str(canonicalize_name(dist))] = name
            if devices:
                if adapter is not None:
                    problems.append("More than one wheel declares teststand.devices entry points")
                adapter = (dist, requires, devices)
        if adapter is None:
            return [*problems, "No wheel declares a teststand.devices entry point"], skipped
        dist, requires, devices = adapter
        if canonicalize_name(dist) != canonicalize_name(manifest["distribution"]):
            problems.append(
                f"Adapter wheel is {dist}, package.json says {manifest['distribution']}"
            )
        if list(devices) != [manifest["type"]]:
            problems.append(
                f"Adapter declares device types {sorted(devices)}, package.json says "
                f"{manifest['type']}"
            )
        try:
            if SDK_VERSION not in SpecifierSet(manifest["sdk"]):
                problems.append(
                    f"Package needs device SDK {manifest['sdk']}; testStand has {SDK_VERSION}"
                )
        except InvalidSpecifier:
            problems.append(f"Invalid SDK range {manifest['sdk']!r}")
        for raw in requires:
            try:
                requirement = Requirement(raw)
            except InvalidRequirement:
                problems.append(f"Invalid requirement {raw!r}")
                continue
            if requirement.marker is not None and not requirement.marker.evaluate({"extra": ""}):
                continue
            key = str(canonicalize_name(requirement.name))
            if key == SDK_DISTRIBUTION:
                if SDK_VERSION not in requirement.specifier:
                    problems.append(f"Adapter needs {raw}; testStand has {SDK_VERSION}")
            elif (shipped := self._shipped(key)) is not None:
                if shipped not in requirement.specifier:
                    problems.append(f"Adapter needs {raw}; testStand ships {key} {shipped}")
            elif key not in provided:
                problems.append(f"Dependency {requirement.name} is not in the package")
        for key, name in provided.items():
            if key == SDK_DISTRIBUTION:
                problems.append("The package must not carry the device SDK; testStand provides it")
            elif self._shipped(key) is not None:
                # testStand's own copy is already on the path ahead of any package site.
                skipped.add(name)
        return problems, skipped

    def _current(self, device_type: str) -> Record | None:
        change = self.state["pending"].get(device_type)
        if change and change["action"] == "install":
            return dict(change["entry"])
        if change and change["action"] == "uninstall":
            return None
        entry = self.state["types"].get(device_type)
        return dict(entry) if entry else None

    def inspect(self, data: bytes) -> Record:
        """What installing ``data`` would do, for the confirmation dialog. Writes nothing."""
        manifest, wheels = _read_archive(data)
        problems, skipped = self._check(manifest, wheels)
        current = self._current(manifest["type"])
        sha = _sha256(data)
        # ``present``: nothing to install, the driver is already here (this exact package, or the
        # development environment ships the adapter itself).
        if self._builtin_owner(manifest["type"]) is not None or (
            current and current["sha256"] == sha
        ):
            action = "present"
        elif current is None:
            action = "install"
        else:
            action = "reinstall" if current["version"] == manifest["version"] else "upgrade"
        return {
            "manifest": manifest,
            "sha256": sha,
            "size": len(data),
            "files": [
                {
                    "name": name,
                    "size": len(content),
                    "sha256": manifest["files"][name],
                    "skipped": name in skipped,
                }
                for name, content in sorted(wheels.items())
            ],
            "action": action,
            "installedVersion": current["version"] if current else None,
            "restartRequired": action in ("reinstall", "upgrade")
            and manifest["type"] in self.state["types"],
            "problems": problems,
        }

    async def install(self, data: bytes) -> Record:
        async with self._lock:
            report = self.inspect(data)
            if report["problems"]:
                raise app_error(
                    "invalid_argument",
                    "Device package cannot be installed: " + "; ".join(report["problems"]),
                    {"problems": report["problems"]},
                )
            manifest, wheels = _read_archive(data)
            if report["action"] == "present":
                return {
                    "type": manifest["type"],
                    "version": manifest["version"],
                    "action": "present",
                    "restartRequired": False,
                }
            device_type = manifest["type"]
            directory = f"{manifest['version']}-{report['sha256'][:12]}"
            target = self.root / device_type / directory
            staging = Path(tempfile.mkdtemp(prefix=".install-", dir=self.root))
            try:
                skipped = {item["name"] for item in report["files"] if item["skipped"]}
                for name, content in wheels.items():
                    if name in skipped:
                        continue
                    await asyncio.to_thread(_extract_wheel, content, staging / "site")
                if target.exists():
                    _remove(target)
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staging, target)
            except BaseException:
                _remove(staging)
                raise
            entry = {
                "dir": directory,
                "version": manifest["version"],
                "distribution": manifest["distribution"],
                "manufacturer": manifest["manufacturer"],
                "model": manifest["model"],
                "isolation": manifest["isolation"],
                "description": manifest["description"],
                "vendorDrivers": manifest["vendorDrivers"],
                "sha256": report["sha256"],
                "installedAt": utc_now_iso(),
            }
            restart = device_type in self.state["types"]
            if restart:
                self.state["pending"][device_type] = {"action": "install", "entry": entry}
            else:
                self.state["pending"].pop(device_type, None)
                self.state["types"][device_type] = entry
            await atomic_json(self._state_file, self.state)
            if not restart:
                activate_plugins(self.root)
            self._prune()
            return {
                "type": device_type,
                "version": manifest["version"],
                "action": report["action"],
                "restartRequired": restart,
            }

    def installed(self, device_type: str) -> bool:
        """Whether ``device_type`` came from a package (and is not already being removed)."""
        change = self.state["pending"].get(device_type)
        return device_type in self.state["types"] and not (
            change and change["action"] == "uninstall"
        )

    async def uninstall(self, device_type: str) -> Record:
        async with self._lock:
            if device_type not in self.state["types"]:
                raise app_error("not_found", f"Device package not installed: {device_type}")
            self.state["pending"][device_type] = {"action": "uninstall"}
            await atomic_json(self._state_file, self.state)
            self._prune()
            return {"type": device_type, "restartRequired": True}
