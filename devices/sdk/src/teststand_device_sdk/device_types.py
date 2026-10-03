"""Installed device types: the ``teststand.devices`` entry points of adapter packages."""

from __future__ import annotations

import importlib
from importlib.metadata import entry_points

from .device import Device

ENTRY_POINT_GROUP = "teststand.devices"


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
