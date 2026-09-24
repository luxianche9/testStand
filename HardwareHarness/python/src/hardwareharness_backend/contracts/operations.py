"""One declaration per application operation: authorization, desktop RPC and MCP tools."""

from __future__ import annotations

import functools
import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, TypeVar, cast

from hardwareharness_backend import CONTRACT_REVISION

from .validation import Schema, json_schema, parse_record

Record = dict[str, Any]
Method = TypeVar("Method", bound=Callable[..., Any])
WHOLE = "*"
"""Tool field marker: pass the whole parsed argument object."""


def operation(capability: str) -> Callable[[Method], Method]:
    """Authorize ``context`` for ``capability`` and expose the method as a desktop operation."""

    def decorate(method: Method) -> Method:
        if inspect.iscoroutinefunction(method):

            @functools.wraps(method)
            async def wrapper(self: Any, context: Record, *args: Any, **kwargs: Any) -> Any:
                self.authorizer.authorize(context, capability)
                return await method(self, context, *args, **kwargs)

        else:

            @functools.wraps(method)
            def wrapper(self: Any, context: Record, *args: Any, **kwargs: Any) -> Any:
                self.authorizer.authorize(context, capability)
                return method(self, context, *args, **kwargs)

        wrapper.capability = capability  # type: ignore[attr-defined]
        return cast(Method, wrapper)

    return decorate


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def desktop_methods(namespaces: Mapping[str, type]) -> dict[str, tuple[str, str]]:
    """Map every ``namespace.camelMethod`` wire name to its decorated Python method."""
    return {
        f"{namespace}.{camel(name)}": (namespace, name)
        for namespace, owner in namespaces.items()
        for name, member in vars(owner).items()
        if hasattr(member, "capability")
    }


@dataclass(frozen=True)
class Tool:
    """A public MCP tool. ``operation`` tools call ``app.<namespace>.<method>(context, *fields)``
    and inherit the operation's capability; other tools supply ``call`` and ``capability``."""

    name: str
    description: str
    input: Schema
    output: Record | bool
    operation: str = ""
    fields: tuple[str, ...] = ()
    call: Callable[[Any, Record, Record], Any] | None = None
    capability: str = ""
    read_only: bool = False
    destructive: bool = False
    idempotent: bool | None = None
    open_world: bool = False
    meta: Record | None = None
    glossary: Mapping[str, str] = field(default_factory=dict)

    def definition(self) -> Record:
        result: Record = {
            "name": self.name,
            "description": self.description,
            "inputSchema": json_schema(self.input, self.glossary),
            "outputSchema": {
                "type": "object",
                "properties": {"ok": {"const": True}, "data": self.output},
                "required": ["ok", "data"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": self.read_only,
                "destructiveHint": self.destructive,
                "idempotentHint": self.read_only if self.idempotent is None else self.idempotent,
                "openWorldHint": self.open_world,
            },
        }
        if self.meta is not None:
            result["_meta"] = {
                "hardwareharness": {"contractRevision": CONTRACT_REVISION, **self.meta}
            }
        return result

    def parse(self, value: Any) -> Record:
        return parse_record(self.input, value)

    async def execute(self, application: Any, context: Record, value: Record) -> Any:
        """Return raw tool data; the registry authorizes, parses and wraps the result."""
        if self.call is not None:
            result = self.call(application, context, value)
        else:
            namespace, method = self.operation.split(".")
            arguments = [value if name == WHOLE else value.get(name) for name in self.fields]
            result = getattr(getattr(application, namespace), method)(context, *arguments)
        return await result if inspect.isawaitable(result) else result


PLATFORM_META: Record = {"kind": "platform", "resultMode": "data"}
