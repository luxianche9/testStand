"""Plan bindings (design §7.6): logical device names mapped to real hardware and streams.

Steps name a binding (``psu_main``) where they would name a ``hardwareId``. ``${name}`` in a
binding takes the run parameter ``name``; a batch supplies one set of values per station.
The compiler expands bindings before anything resolves tools or streams, so the device,
tool and stream checks run against the hardware a station really uses.
"""

from __future__ import annotations

import re
from typing import Any

from hardwareharness_backend.util import clone

from .models import STREAM_STEPS, iter_steps

Record = dict[str, Any]
BINDING_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
BINDING_FIELDS = ("hardwareId", "streamId")
_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _issue(code: str, message: str, path: str) -> Record:
    return {"severity": "error", "code": code, "message": message, "path": path}


def default_values(plan: Record) -> Record:
    """Parameter defaults: what validation fills placeholders with when no station is given."""
    return {
        item["name"]: item["default"]
        for item in plan.get("parameters", []) or []
        if isinstance(item, dict) and isinstance(item.get("name"), str) and "default" in item
    }


def expand_bindings(plan: Record, values: Record | None = None) -> tuple[Record, list[Record]]:
    """``plan`` with every binding name replaced by its hardware, plus the binding issues."""
    bindings = plan.get("bindings")
    if bindings is None:
        return plan, []
    if not isinstance(bindings, dict):
        return plan, [_issue("binding.invalid", "bindings must be an object", "/bindings")]
    scope = {**default_values(plan), **(values or {})}
    issues: list[Record] = []
    resolved: dict[str, Record] = {}
    for name, entry in bindings.items():
        path = f"/bindings/{name}"
        if not isinstance(name, str) or not BINDING_NAME.fullmatch(name):
            issues.append(_issue("binding.name", f"Invalid binding name {name}", path))
            continue
        if not isinstance(entry, dict):
            issues.append(_issue("binding.invalid", "A binding must be an object", path))
            continue
        unknown = sorted(set(entry) - set(BINDING_FIELDS))
        if unknown:
            issues.append(_issue("binding.invalid", f"Unknown binding field {unknown[0]}", path))
        output: Record = {}
        for field in BINDING_FIELDS:
            if field not in entry and field == "streamId":
                continue
            value = entry.get(field)
            if not isinstance(value, str) or not value.strip():
                issues.append(
                    _issue("binding.invalid", f"{field} must be text", path + "/" + field)
                )
                continue
            text, missing = _substitute(value, scope)
            issues.extend(
                _issue(
                    "binding.variable",
                    f"Binding {name} uses ${{{variable}}}, but no run parameter or station "
                    "value provides it",
                    path + "/" + field,
                )
                for variable in missing
            )
            output[field] = text
        if "hardwareId" in output:
            resolved[name] = output
    expanded = clone(plan)
    for _, step in iter_steps(expanded):
        _apply(step, resolved, step.get("type") in STREAM_STEPS)
    for item in expanded.get("protocolBindings", []) or []:
        if isinstance(item, dict) and isinstance(item.get("source"), dict):
            _apply(item["source"], resolved, True)
    return expanded, issues


def _substitute(text: str, scope: Record) -> tuple[str, list[str]]:
    missing: list[str] = []

    def replace(match: re.Match[str]) -> str:
        value = scope.get(match.group(1))
        if value is None:
            missing.append(match.group(1))
            return match.group(0)
        return str(value)

    return _PLACEHOLDER.sub(replace, text), missing


def _apply(target: Record, resolved: dict[str, Record], streams: bool) -> None:
    binding = resolved.get(str(target.get("hardwareId", "")))
    if not binding:
        return
    target["hardwareId"] = binding["hardwareId"]
    if streams and "streamId" in binding and not target.get("streamId"):
        target["streamId"] = binding["streamId"]
