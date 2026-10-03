"""``@tool`` declarations: explicit operation semantics instead of name heuristics."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Literal, TypeVar, get_type_hints

from pydantic import BaseModel, ConfigDict, Field

ToolKind = Literal["read", "configure", "actuate", "safe"]
TOOL_KINDS: tuple[str, ...] = ("read", "configure", "actuate", "safe")


class ToolAnnotations(BaseModel):
    """Behavior hints of a tool, published as its ``annotations`` (MCP tool annotation keys)."""

    model_config = ConfigDict(frozen=True)

    readOnlyHint: bool  # noqa: N815
    destructiveHint: bool  # noqa: N815
    idempotentHint: bool  # noqa: N815
    openWorldHint: bool  # noqa: N815


READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
OPERATE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)

HardwareId = Annotated[str, Field(description="Bound hardwareId from list_hardware; the HH gateway supplies this automatically.",
                                  min_length=1)]

F = TypeVar("F", bound=Callable[..., Any])
_MARK = "__hardwareharness_tool__"


def param(typ: Any, description: str, **constraints: Any) -> Any:
    """Annotated parameter type with a mandatory description and pydantic constraints."""
    return Annotated[typ, Field(description=description, **constraints)]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    kind: ToolKind
    description: str
    output: Any
    attr: str
    requires: tuple[str, ...] = ()
    effects: tuple[str, ...] = ()
    evidence: str | None = None
    safety_action: str | Mapping[str, Any] | None = None

    def full_name(self, prefix: str) -> str:
        return f"{prefix}_{self.name}" if prefix else self.name

    def annotations(self) -> ToolAnnotations:
        return READ_ONLY if self.kind == "read" else OPERATE

    def semantics(self, prefix: str) -> dict[str, Any]:
        evidence = self.evidence or ("controller_state" if self.kind == "read" else "observation")
        result: dict[str, Any] = {
            "kind": self.kind,
            "retry": "never_after_dispatch" if self.kind == "actuate" else "safe",
            "stateRequirements": list(self.requires),
            "stateEffects": list(self.effects),
            "evidenceType": evidence,
            "outcomeOnInvalidResponse": "unknown",
            "trusted": True,
        }
        if self.safety_action is not None:
            action = ({"toolName": self.safety_action, "arguments": {}} if isinstance(self.safety_action, str)
                      else dict(self.safety_action))
            name = str(action["toolName"])
            action["toolName"] = name if name.startswith(f"{prefix}_") else f"{prefix}_{name}"
            action.setdefault("arguments", {})
            result["safetyAction"] = action
        return result


def tool(
    *,
    kind: ToolKind,
    description: str,
    output: Any = None,
    name: str | None = None,
    requires: tuple[str, ...] | list[str] = (),
    effects: tuple[str, ...] | list[str] = (),
    evidence: str | None = None,
    safety_action: str | Mapping[str, Any] | None = None,
) -> Callable[[F], F]:
    """Publish a blocking ``Device`` method as ``<prefix>_<name>``.

    The method runs in a worker thread under the device operation lock. Its
    parameters must be ``Annotated[..., Field(description=...)]``; ``hardwareId``
    is prepended by the SDK. ``safety_action`` names the tool that restores a
    safe state after this action (short or prefixed name).
    """
    if kind not in TOOL_KINDS:
        raise ValueError(f"Unknown tool kind: {kind}")

    def mark(fn: F) -> F:
        setattr(fn, _MARK, ToolSpec(name=name or fn.__name__, kind=kind, description=description, output=output,
                                    attr=fn.__name__, requires=tuple(requires), effects=tuple(effects),
                                    evidence=evidence, safety_action=safety_action))
        return fn
    return mark


def collect_tools(cls: type) -> list[ToolSpec]:
    """Tool specs in definition order; subclasses may override a base tool."""
    specs: dict[str, ToolSpec] = {}
    for klass in reversed(cls.__mro__):
        for value in vars(klass).values():
            spec = getattr(value, _MARK, None)
            if isinstance(spec, ToolSpec):
                specs.pop(spec.attr, None)
                specs[spec.attr] = spec
    return list(specs.values())


def method_parameters(fn: Callable[..., Any]) -> list[inspect.Parameter]:
    """Keyword parameters with resolved (``include_extras``) annotations, without ``self``."""
    hints = get_type_hints(fn, include_extras=True)
    params = []
    for item in inspect.signature(fn).parameters.values():
        if item.name == "self":
            continue
        if item.kind in {inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD}:
            raise TypeError(f"{fn.__qualname__}: tools cannot take *args/**kwargs")
        params.append(item.replace(kind=inspect.Parameter.KEYWORD_ONLY, annotation=hints.get(item.name, Any)))
    return params
