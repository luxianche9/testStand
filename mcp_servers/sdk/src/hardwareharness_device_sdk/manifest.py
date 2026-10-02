"""Device declaration ``GET /device`` and its static assets ``GET /assets/{path}``.

The declaration is generated, never hand-written: identity from the class
attributes and ``server.json``, ``pinout()``, ``capability_details()``, the
stream registry, the registered tools and the images in the adapter
package's ``assets/`` directory.

``manifestRevision`` is ``sha256:`` over the canonical JSON of the rest of the
document plus the bytes of every referenced asset, so any change (adapter
upgrade, driver mode switch, new picture) changes it and tells the terminal
to refetch. Assets are PNG, JPEG, WebP or SVG files of at most 2 MB inside
``assets/``; paths are relative to it (``appearance.svg``, ``ports/CN1.svg``)
and never contain ``..``.
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from ._version import __version__
from .envelope import CONTRACT_REVISION
from .errors import NOT_SUPPORTED, DeviceError

if TYPE_CHECKING:
    from .app import DeviceService

MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
               ".svg": "image/svg+xml"}
MAX_ASSET_BYTES = 2 << 20
APPEARANCE_STEM = "appearance"


class AssetError(ValueError):
    """The asset path is not allowed (absolute, ``..``, wrong type, too large)."""


def media_type(path: str) -> str:
    suffix = PurePosixPath(path).suffix.lower()
    if suffix not in MEDIA_TYPES:
        raise AssetError(f"{path}: assets must be PNG, JPEG, WebP or SVG, not {suffix or 'no extension'}")
    return MEDIA_TYPES[suffix]


def resolve_asset(root: Path, path: str) -> Path:
    """File for ``path`` inside ``root``; :class:`AssetError` when not allowed, ``FileNotFoundError`` when absent."""
    if not path or "\\" in path or "\0" in path or path.startswith("/") or ":" in path:
        raise AssetError(f"{path!r}: asset paths are relative to assets/ and use forward slashes")
    parts = path.split("/")
    if any(part in {"", "..", "."} for part in parts):
        raise AssetError(f"{path!r}: asset paths must not contain '..', '.' or empty segments")
    media_type(path)
    base = root.resolve()
    target = (base / Path(*parts)).resolve()
    if not target.is_relative_to(base):
        raise AssetError(f"{path!r}: resolves outside assets/")
    if not target.is_file():
        raise FileNotFoundError(path)
    size = target.stat().st_size
    if size > MAX_ASSET_BYTES:
        raise AssetError(f"{path}: {size} bytes is above the {MAX_ASSET_BYTES} byte asset limit")
    return target


_SVG_TAG = re.compile(rb"<svg\b[^>]*>", re.IGNORECASE | re.DOTALL)
_SVG_ATTR = re.compile(rb"""\b(width|height|viewBox)\s*=\s*["']([^"']*)["']""")
_LENGTH = re.compile(rb"^\s*([0-9]+(?:\.[0-9]+)?)\s*(?:px)?\s*$")


def _svg_size(data: bytes) -> tuple[int | None, int | None]:
    tag = _SVG_TAG.search(data[:4096])
    if tag is None:
        return None, None
    attrs = {key.decode(): value for key, value in _SVG_ATTR.findall(tag.group(0))}
    sizes: list[int | None] = []
    for key in ("width", "height"):
        match = _LENGTH.match(attrs.get(key, b""))
        sizes.append(round(float(match.group(1))) if match else None)
    if None in sizes and "viewBox" in attrs:
        box = attrs["viewBox"].replace(b",", b" ").split()
        if len(box) == 4:
            try:
                return round(float(box[2])), round(float(box[3]))
            except ValueError:
                pass
    return sizes[0], sizes[1]


def _jpeg_size(data: bytes) -> tuple[int | None, int | None]:
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            return None, None
        marker = data[index + 1]
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in {0xC4, 0xC8, 0xCC}:
            height, width = struct.unpack(">HH", data[index + 5:index + 9])
            return width, height
        index += 2 + length
    return None, None


def _webp_size(data: bytes) -> tuple[int | None, int | None]:
    chunk = data[12:16]
    if chunk == b"VP8X" and len(data) >= 30:
        return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
    if chunk == b"VP8 " and len(data) >= 30:
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L" and len(data) >= 25:
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None, None


def image_size(data: bytes, mime: str) -> tuple[int | None, int | None]:
    """Pixel (or SVG user unit) size when the header states it; ``(None, None)`` otherwise."""
    if mime == "image/png" and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        return width, height
    if mime == "image/jpeg" and data[:2] == b"\xff\xd8":
        return _jpeg_size(data)
    if mime == "image/webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return _webp_size(data)
    if mime == "image/svg+xml":
        return _svg_size(data)
    return None, None


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


@dataclass
class Manifest:
    document: dict[str, Any]
    """The ``/device`` body, ``manifestRevision`` first."""
    assets: dict[str, bytes] = field(default_factory=dict)
    """Referenced asset path -> content."""
    problems: list[str] = field(default_factory=list)
    """Contract violations (invalid asset references); ``--check`` fails on them."""
    warnings: list[str] = field(default_factory=list)
    """Missing pictures or description; ``--check`` only warns."""

    @property
    def revision(self) -> str:
        return str(self.document["manifestRevision"])


class _Assets:
    def __init__(self, root: Path, manifest: Manifest) -> None:
        self.root = root
        self.manifest = manifest

    def load(self, path: str, where: str) -> tuple[str, bytes] | None:
        try:
            target = resolve_asset(self.root, path)
            content = self.manifest.assets.get(path)
            if content is None:
                content = self.manifest.assets[path] = target.read_bytes()
            return media_type(path), content
        except FileNotFoundError:
            self.manifest.problems.append(f"{where}: asset {path!r} not found in {self.root}")
        except (AssetError, OSError) as exc:
            self.manifest.problems.append(f"{where}: {exc}")
        return None


def _appearance(device_cls: type[Any], assets: _Assets) -> dict[str, Any] | None:
    declared = getattr(device_cls, "appearance_image", None)
    if declared is None:
        root = assets.root
        declared = next((f"{APPEARANCE_STEM}{suffix}" for suffix in MEDIA_TYPES
                         if (root / f"{APPEARANCE_STEM}{suffix}").is_file()), None)
        if declared is None:
            assets.manifest.warnings.append(
                f"no appearance image: add assets/{APPEARANCE_STEM}.(png|jpg|webp|svg) or set appearance_image")
            return None
    loaded = assets.load(declared, "appearance_image")
    if loaded is None:
        return None
    mime, content = loaded
    image: dict[str, Any] = {"asset": declared, "mediaType": mime}
    width, height = image_size(content, mime)
    if width and height:
        image.update(width=width, height=height)
    return image


def _pinout(service: DeviceService, assets: _Assets) -> dict[str, Any] | None:
    manifest = assets.manifest
    try:
        pinout = service.manager.get_pinout(service.device.hardware_id)
    except DeviceError as exc:
        if exc.category != NOT_SUPPORTED:
            manifest.problems.append(f"pinout(): {exc}")
        return None
    except Exception as exc:
        manifest.problems.append(f"pinout(): {type(exc).__name__}: {exc}")
        return None
    data = pinout.model_dump(mode="json", exclude_none=True)
    for connector in data["connectors"]:
        where = f"connector {connector['connectorId']}"
        image = connector.get("image")
        if image is None:
            manifest.warnings.append(f"{where}: no port image (Connector.image)")
            continue
        loaded = assets.load(image["asset"], f"{where} image")
        if loaded is None:
            connector.pop("image")
            continue
        declared = image.get("mediaType")
        if declared is not None and declared != loaded[0]:
            manifest.problems.append(f"{where} image: mediaType {declared} does not match {loaded[0]}")
        image["mediaType"] = loaded[0]
        unknown = [item["pinId"] for item in image.get("pinPositions") or () if item["pinId"] not in connector["pinIds"]]
        if unknown:
            manifest.problems.append(f"{where} image: pinPositions name pins not on this connector: {unknown}")
        if not image.get("pinPositions"):
            image.pop("pinPositions", None)
    return data


def build_manifest(service: DeviceService) -> Manifest:
    """Generate the ``/device`` document for ``service`` (reads software state only, never the driver)."""
    device = service.device
    device_cls = type(device)
    manifest = Manifest(document={})
    assets = _Assets(device_cls.assets_dir(), manifest)
    identity: dict[str, Any] = {
        "serverId": service.config.server_id, "hardwareId": device.hardware_id,
        "manufacturer": device_cls.manufacturer, "model": device_cls.model,
        "hardwareRevision": getattr(device_cls, "hardware_revision", None),
        "adapter": {"name": device_cls.__module__.split(".")[0], "version": device_cls.version},
        "sdkVersion": __version__, "dryRun": bool(service.config.dry_run or device.simulated_driver)}
    identity = {key: value for key, value in identity.items() if value is not None}
    description = str(getattr(device_cls, "description", "") or "")
    if not description:
        manifest.warnings.append("no description: set the Device.description class attribute")
    appearance = _appearance(device_cls, assets)
    body: dict[str, Any] = {
        "contractRevision": CONTRACT_REVISION,
        "identity": identity,
        "description": description,
        "images": {"appearance": appearance} if appearance is not None else {},
        "pinout": _pinout(service, assets),
        "streams": device.streams.describe(),
        "capabilities": service.capability_details(),
        "tools": [{"name": name, "kind": kind} for name, kind in service.tool_kinds.items()],
    }
    digest = hashlib.sha256(canonical_json(body))
    for path in sorted(manifest.assets):
        digest.update(b"\0" + path.encode() + b"\0")
        digest.update(manifest.assets[path])
    manifest.document = {"manifestRevision": f"sha256:{digest.hexdigest()}", **body}
    return manifest
