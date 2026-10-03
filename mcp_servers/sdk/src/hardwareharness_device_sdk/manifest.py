"""Device declaration (``/device``).

The declaration is generated, never hand-written: identity from the class
attributes and the host config, ``pinout()``, ``capability_details()``, the
stream registry and the registered tools.

``manifestRevision`` is ``sha256:`` over the canonical JSON of the rest of the
document, so any change (adapter upgrade, driver mode switch) changes it and
tells the terminal to refetch.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ._version import __version__
from .envelope import CONTRACT_REVISION
from .errors import NOT_SUPPORTED, DeviceError

if TYPE_CHECKING:
    from .host import DeviceHost


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


@dataclass
class Manifest:
    document: dict[str, Any]
    """The ``/device`` body, ``manifestRevision`` first."""
    problems: list[str] = field(default_factory=list)
    """Contract violations (a failing ``pinout()``); ``--check`` fails on them."""
    warnings: list[str] = field(default_factory=list)
    """Missing description; ``--check`` only warns."""

    @property
    def revision(self) -> str:
        return str(self.document["manifestRevision"])


def _pinout(service: DeviceHost, manifest: Manifest) -> dict[str, Any] | None:
    try:
        pinout = service.manager.get_pinout(service.device.hardware_id)
    except DeviceError as exc:
        if exc.category != NOT_SUPPORTED:
            manifest.problems.append(f"pinout(): {exc}")
        return None
    except Exception as exc:
        manifest.problems.append(f"pinout(): {type(exc).__name__}: {exc}")
        return None
    return pinout.model_dump(mode="json", exclude_none=True)


def build_manifest(service: DeviceHost) -> Manifest:
    """Generate the ``/device`` document for ``service`` (reads software state only, never the driver)."""
    device = service.device
    device_cls = type(device)
    manifest = Manifest(document={})
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
    body: dict[str, Any] = {
        "contractRevision": CONTRACT_REVISION,
        "identity": identity,
        "description": description,
        "pinout": _pinout(service, manifest),
        "streams": device.streams.describe(),
        "capabilities": service.capability_details(),
        "tools": [{"name": name, "kind": kind} for name, kind in service.tool_kinds.items()],
    }
    digest = hashlib.sha256(canonical_json(body))
    manifest.document = {"manifestRevision": f"sha256:{digest.hexdigest()}", **body}
    return manifest
