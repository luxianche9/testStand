"""Installed device types: the ``teststand.devices`` entry points of adapter packages."""

from __future__ import annotations

import importlib
import json
import os
import sys
from importlib.metadata import entry_points
from pathlib import Path

from .device import Device

ENTRY_POINT_GROUP = "teststand.devices"
PLUGINS_ENV = "TESTSTAND_PLUGINS_DIR"
"""Root of the installed device packages; the backend sets it so isolated children see the same."""
INSTALLED_FILE = "installed.json"


def plugin_sites(root: Path) -> list[Path]:
    """``<root>/<type>/<dir>/site`` of every installed device package (``installed.json``; ``dir``
    defaults to the version)."""
    try:
        installed = json.loads((root / INSTALLED_FILE).read_text(encoding="utf-8")).get("types", {})
    except (OSError, ValueError, AttributeError):
        return []
    return [root / name / str(entry.get("dir") or entry["version"]) / "site"
            for name, entry in sorted(installed.items()) if isinstance(entry, dict) and "version" in entry]


def activate_plugins(root: str | Path | None = None) -> list[Path]:
    """Put installed device packages on ``sys.path`` so their entry points and modules resolve.

    ``root`` defaults to ``$TESTSTAND_PLUGINS_DIR``; without either nothing changes. Each site is an
    unpacked wheel (package plus ``*.dist-info``), appended after the interpreter's own paths.
    """
    base = root if root is not None else os.environ.get(PLUGINS_ENV)
    if not base:
        return []
    added = [site for site in plugin_sites(Path(base)) if site.is_dir() and str(site) not in sys.path]
    sys.path.extend(str(site) for site in added)
    if added:
        importlib.invalidate_caches()
    return added


def device_types() -> dict[str, str]:
    """Installed device types: entry point name -> ``module:attr``."""
    return {item.name: item.value for item in entry_points(group=ENTRY_POINT_GROUP)}


def load_device(spec: str) -> type[Device]:
    """A device type name from the ``teststand.devices`` entry points, else ``module``
    (exposing ``DEVICE``) or ``module:Name``."""
    found = next((item for item in entry_points(group=ENTRY_POINT_GROUP) if item.name == spec), None)
    if found is not None:
        target = found.load()
    else:
        module_name, _, attr = spec.partition(":")
        target = getattr(importlib.import_module(module_name), attr or "DEVICE")
    if not (isinstance(target, type) and issubclass(target, Device)):
        raise TypeError(f"{spec} is not a Device subclass")
    return target
