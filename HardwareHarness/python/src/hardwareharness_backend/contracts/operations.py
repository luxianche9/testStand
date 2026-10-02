"""One declaration per operation: the ``@operation`` registry entry and the MCP ``Tool``.

``@operation(name, capability=..., risk=...)`` marks an application method as a public
operation (design doc §9.3). Its request model is derived once, when the registry is
collected at startup, from the method's parameters after ``context``: wire fields are the
camelCase parameter names and requests pass arguments by name. HTTP, OpenAPI and the TS
client are generated from the collected definitions.
"""

from __future__ import annotations

import functools
import inspect
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar, cast, get_args

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, create_model

from hardwareharness_backend import CONTRACT_REVISION

from .validation import Schema, json_schema, parse_record

Record = dict[str, Any]
Method = TypeVar("Method", bound=Callable[..., Any])
Risk = Literal["read", "write", "actuate", "destructive"]
Idempotency = Literal["none", "natural", "request-id"]
RISKS: tuple[str, ...] = get_args(Risk)
IDEMPOTENCY: tuple[str, ...] = get_args(Idempotency)
Mode = Literal["adapter", "plan", "run", "explore"]
MODES: tuple[str, ...] = get_args(Mode)
"""Agent work modes (design doc 8.2); an operation's ``profiles`` names the modes it appears in."""
WHOLE = "*"
"""Tool field marker: pass the whole parsed argument object."""
SENSITIVE_FIELDS = frozenset(
    {
        "authorization",
        "password",
        "passphrase",
        "privatekey",
        "secret",
        "token",
        "accesstoken",
        "bearertoken",
        "apikey",
        "mcptoken",
        "credentials",
    }
)
"""Casefolded field names redacted in audit records and marked ``x-sensitive``."""


@dataclass(frozen=True)
class OperationSpec:
    """What ``@operation`` declares; ``collect_operations`` derives the request model."""

    name: str
    capability: str
    risk: Risk
    profiles: frozenset[str]
    idempotency: Idempotency
    confirm: bool
    function: Callable[..., Any]


class OperationRequest(BaseModel):
    """Base of every request model: camelCase on the wire, unknown fields rejected."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        arbitrary_types_allowed=True,
        val_json_bytes="base64",
        ser_json_bytes="base64",
    )


@dataclass(frozen=True)
class OperationDefinition:
    """A collected operation: its spec, request model and owning application namespace."""

    spec: OperationSpec
    namespace: str
    method: str
    request: type[OperationRequest]
    parameters: tuple[tuple[str, str], ...]
    """``(wireName, pythonName)`` in declaration order."""
    bytes_fields: tuple[str, ...]
    returns_bytes: bool
    response_schema: Record
    summary: str

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def read_only(self) -> bool:
        return self.spec.risk == "read"

    def arguments(self, request: OperationRequest) -> Record:
        """Keyword arguments for the method, by Python parameter name."""
        return {python: getattr(request, python) for _, python in self.parameters}


def operation(
    name: str,
    *,
    capability: str,
    risk: Risk,
    profiles: Iterable[str] = (),
    idempotency: Idempotency = "none",
    confirm: bool = False,
) -> Callable[[Method], Method]:
    """Declare a public operation. Direct Python calls still authorize ``context``."""
    if risk not in RISKS:
        raise ValueError(f"Unknown operation risk {risk!r} for {name}")
    if idempotency not in IDEMPOTENCY:
        raise ValueError(f"Unknown idempotency {idempotency!r} for {name}")
    if unknown := set(profiles) - set(MODES):
        raise ValueError(f"Unknown work modes {sorted(unknown)} for {name}")

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

        spec = OperationSpec(
            name, capability, risk, frozenset(profiles), idempotency, confirm, method
        )
        wrapper.capability = capability  # type: ignore[attr-defined]
        wrapper.__operation__ = spec  # type: ignore[attr-defined]
        return cast(Method, wrapper)

    return decorate


def operation_spec(member: Any) -> OperationSpec | None:
    spec = getattr(member, "__operation__", None)
    return spec if isinstance(spec, OperationSpec) else None


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def collect_operations(namespaces: Mapping[str, type]) -> dict[str, OperationDefinition]:
    """Collect every ``@operation`` of the application namespaces, once, at startup."""
    registry: dict[str, OperationDefinition] = {}
    for namespace, owner in namespaces.items():
        for method, member in vars(owner).items():
            spec = operation_spec(member)
            if spec is None:
                continue
            if spec.name in registry:
                raise RuntimeError(f"Duplicate operation name: {spec.name}")
            registry[spec.name] = _definition(spec, namespace, method)
    return registry


def _definition(spec: OperationSpec, namespace: str, method: str) -> OperationDefinition:
    function = spec.function
    signature = inspect.signature(function)
    fields: dict[str, Any] = {}
    parameters: list[tuple[str, str]] = []
    bytes_fields: list[str] = []
    for parameter in list(signature.parameters.values())[2:]:
        if parameter.kind not in (parameter.POSITIONAL_OR_KEYWORD, parameter.KEYWORD_ONLY):
            raise TypeError(f"{spec.name}: operations take named parameters only")
        annotation = _annotation(function, parameter.annotation)
        alias = camel(parameter.name)
        extra: Record | None = {"x-sensitive": True} if is_sensitive(alias) else None
        default: Any = parameter.default
        if default is parameter.empty:
            # An optional parameter without a default may be omitted: it means ``None``.
            default = None if type(None) in get_args(annotation) else ...
        fields[parameter.name] = (annotation, Field(default, alias=alias, json_schema_extra=extra))
        parameters.append((alias, parameter.name))
        if _is_bytes(annotation):
            bytes_fields.append(alias)
    model_name = "".join(part[:1].upper() + part[1:] for part in spec.name.split(".")) + "Request"
    request = create_model(model_name, __base__=OperationRequest, **fields)
    returns = _annotation(function, signature.return_annotation)
    return OperationDefinition(
        spec=spec,
        namespace=namespace,
        method=method,
        request=request,
        parameters=tuple(parameters),
        bytes_fields=tuple(bytes_fields),
        returns_bytes=_is_bytes(returns),
        response_schema=_response_schema(returns),
        summary=(inspect.getdoc(function) or "").split("\n\n")[0],
    )


def is_sensitive(name: str) -> bool:
    return name.replace("_", "").replace("-", "").casefold() in SENSITIVE_FIELDS


def _annotation(function: Callable[..., Any], annotation: Any) -> Any:
    if annotation is inspect.Parameter.empty:
        return Any
    if not isinstance(annotation, str):
        return annotation
    try:
        return eval(annotation, getattr(function, "__globals__", {}))  # noqa: S307
    except Exception:
        return Any


def _is_bytes(annotation: Any) -> bool:
    return annotation is bytes or bytes in get_args(annotation)


def _response_schema(annotation: Any) -> Record:
    if annotation is None or annotation is type(None):
        return {"type": "null"}
    if annotation is bytes:
        return {"type": "string", "contentEncoding": "base64"}
    try:
        return TypeAdapter(annotation).json_schema()
    except Exception:
        return {}


@dataclass(frozen=True)
class Tool:
    """How one gateway tool is presented to an Agent: name, description, schemas and glossary.

    ``operation`` tools name a registry operation; the gateway takes their capability, modes and
    annotations from it and invokes it through the registry middleware. ``fields`` are passed in
    the order of the operation's parameters (``WHOLE`` passes the whole parsed object), unless
    ``arguments`` builds the payload. Gateway-only tools supply ``call``, ``capability`` and
    ``profiles`` (no profiles: every mode)."""

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
    arguments: Callable[[Record], Record] | None = None
    """Operation payload (wire names) from the parsed tool arguments."""
    result: Callable[[Any], Any] | None = None
    """Shapes the operation's result for the Agent."""
    check: Callable[[Any, Record], Any] | None = None
    """Precondition ``(application, context)`` checked before the operation is invoked."""
    profiles: frozenset[str] = frozenset()

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

    def payload(self, parameters: Iterable[str], value: Record) -> Record:
        """The operation request for the parsed ``value``; omitted optional fields stay unset."""
        if self.arguments is not None:
            return self.arguments(value)
        items = zip(parameters, self.fields, strict=False)
        return {
            wire: value if name == WHOLE else value[name]
            for wire, name in items
            if name == WHOLE or value.get(name) is not None
        }

    async def execute(self, application: Any, context: Record, value: Record) -> Any:
        """Run a gateway-only tool; the registry authorizes, parses and wraps the result."""
        if self.call is None:
            raise TypeError(f"{self.name} is an operation tool; invoke it through the registry")
        result = self.call(application, context, value)
        return await result if inspect.isawaitable(result) else result


PLATFORM_META: Record = {"kind": "platform", "resultMode": "data"}
