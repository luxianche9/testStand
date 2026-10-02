"""The operation registry and its middleware (design doc §9.3).

Every entry point (HTTP and the Agent MCP gateway) calls ``OperationRegistry.invoke``
with a request context, an operation name and a payload. The steps run in a fixed order:

1. parse and validate the request model (``invalid_argument``);
2. check the caller's capability;
3. ``confirm=True`` operations called by an Agent wait for the operator's confirmation;
4. ``idempotency="request-id"`` requests replay a finished result for a repeated ``requestId``;
5. execute;
6. append an audit record (non-read operations and every failure), redacted and bounded;
7. an ``actuate`` operation whose outcome is unknown (timeout, lost connection) fails with
   ``unknown_outcome`` and is never retried automatically.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import json
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Protocol

from pydantic import ValidationError

from hardwareharness_backend.contracts.errors import AppError, to_wire_error
from hardwareharness_backend.contracts.operations import OperationDefinition, OperationRequest
from hardwareharness_backend.contracts.wire import summarize
from hardwareharness_backend.util import Record, utc_now_iso

Payload = Mapping[str, Any] | str | bytes | bytearray | None
Confirmer = Callable[[Record, OperationDefinition, Record], Awaitable[bool]]
"""Ask the operator to confirm ``definition`` for ``context``; resolve to the decision."""
LEDGER_SIZE = 1000


class AuditSink(Protocol):
    def append(self, record: Record) -> None: ...


class OperationRegistry:
    def __init__(
        self,
        application: Any,
        definitions: Mapping[str, OperationDefinition],
        *,
        audit: AuditSink | None = None,
        confirmer: Confirmer | None = None,
    ) -> None:
        self.application = application
        self.definitions = dict(definitions)
        self.audit = audit
        self.confirmer = confirmer
        self._ledger: OrderedDict[tuple[str, str], tuple[str, asyncio.Future[Any]]] = OrderedDict()

    def get(self, name: str) -> OperationDefinition:
        definition = self.definitions.get(name)
        if definition is None:
            raise AppError("not_found", f"Unknown operation: {name}", {"operation": name})
        return definition

    def parse(self, definition: OperationDefinition, payload: Payload) -> OperationRequest:
        try:
            if payload is None:
                return definition.request.model_validate({})
            if isinstance(payload, (str, bytes, bytearray)):
                return definition.request.model_validate_json(payload or b"{}")
            return definition.request.model_validate(dict(payload))
        except ValidationError as error:
            issues = error.errors(include_url=False, include_context=False, include_input=False)
            raise AppError(
                "invalid_argument",
                f"Invalid request for {definition.name}: {error.error_count()} problem(s)",
                {"operation": definition.name, "issues": [dict(issue) for issue in issues]},
            ) from None

    async def invoke(self, context: Record, name: str, payload: Payload = None) -> Any:
        started = time.monotonic()
        definition: OperationDefinition | None = None
        arguments: Record = {}
        try:
            definition = self.get(name)
            request = self.parse(definition, payload)
            arguments = definition.arguments(request)
            self.application.authorizer.authorize(context, definition.spec.capability)
            await self._confirm(context, definition, arguments)
            result = await self._idempotent(definition, arguments, context)
        except Exception as error:
            failure = self._unknown_outcome(definition, error)
            self._audit(context, name, definition, arguments, started, failure)
            if failure is error:
                raise
            raise failure from error
        self._audit(context, name, definition, arguments, started, None)
        return result

    async def _confirm(
        self, context: Record, definition: OperationDefinition, arguments: Record
    ) -> None:
        if not definition.spec.confirm or context.get("actor") != "agent":
            return
        details = {"operation": definition.name, "confirmationRequired": True}
        if self.confirmer is None:
            raise AppError(
                "permission_denied", f"{definition.name} needs the operator's confirmation", details
            )
        if not await self.confirmer(context, definition, summarize(arguments)):
            raise AppError("permission_denied", f"The operator declined {definition.name}", details)

    async def _idempotent(
        self, definition: OperationDefinition, arguments: Record, context: Record
    ) -> Any:
        request_id = _request_id(arguments) if definition.spec.idempotency == "request-id" else None
        if request_id is None:
            return await self._execute(definition, arguments, context)
        key = (definition.name, request_id)
        fingerprint = _fingerprint(arguments)
        existing = self._ledger.get(key)
        if existing is not None:
            if existing[0] != fingerprint:
                raise AppError(
                    "conflict",
                    "requestId was already used with different arguments",
                    {"operation": definition.name, "requestId": request_id},
                )
            self._ledger.move_to_end(key)
            return await asyncio.shield(existing[1])
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._ledger[key] = (fingerprint, future)
        while len(self._ledger) > LEDGER_SIZE:
            self._ledger.popitem(last=False)
        try:
            result = await self._execute(definition, arguments, context)
        except BaseException as error:
            # A failed attempt is not a recorded outcome: the caller may try again.
            self._ledger.pop(key, None)
            if isinstance(error, Exception):
                future.set_exception(error)
                future.exception()  # Mark retrieved: concurrent waiters may not exist.
            else:
                future.cancel()
            raise
        future.set_result(result)
        return result

    async def _execute(
        self, definition: OperationDefinition, arguments: Record, context: Record
    ) -> Any:
        owner = getattr(self.application, definition.namespace)
        result = getattr(owner, definition.method)(context, **arguments)
        return await result if inspect.isawaitable(result) else result

    def _unknown_outcome(
        self, definition: OperationDefinition | None, error: Exception
    ) -> Exception:
        if definition is None or definition.spec.risk != "actuate":
            return error
        details = getattr(error, "details", None)
        unknown = isinstance(error, (TimeoutError, ConnectionError)) or (
            isinstance(error, AppError)
            and isinstance(details, dict)
            and details.get("outcomeKnown") is False
        )
        if not unknown or (isinstance(error, AppError) and error.category == "unknown_outcome"):
            return error
        wire = to_wire_error(error)
        carried = details if isinstance(details, dict) else {}
        return AppError(
            "unknown_outcome",
            f"{definition.name}: the result is unknown ({wire['message']}); "
            "check the device state and reconcile instead of retrying",
            {
                **carried,
                "operation": definition.name,
                "cause": wire["category"],
                "outcomeKnown": False,
                "automaticRetry": False,
            },
        )

    def _audit(
        self,
        context: Record,
        name: str,
        definition: OperationDefinition | None,
        arguments: Record,
        started: float,
        error: Exception | None,
    ) -> None:
        read = definition is not None and definition.read_only
        if self.audit is None or (error is None and read):
            return
        record: Record = {
            "at": utc_now_iso(),
            "actor": context.get("actor"),
            "source": context.get("source"),
            "operation": name,
            "risk": definition.spec.risk if definition else None,
            "arguments": summarize(arguments),
            "outcome": "ok" if error is None else "error",
            "durationMs": round((time.monotonic() - started) * 1000, 1),
        }
        if error is not None:
            wire = to_wire_error(error)
            record["error"] = {"category": wire["category"], "message": summarize(wire["message"])}
        with contextlib.suppress(Exception):  # Auditing never fails the operation.
            self.audit.append(record)


def _request_id(arguments: Record) -> str | None:
    for value in (arguments, *(item for item in arguments.values() if isinstance(item, dict))):
        # Top-level arguments carry Python names; nested request bodies keep wire names.
        for field in ("request_id", "requestId"):
            request_id = value.get(field) if isinstance(value, dict) else None
            if isinstance(request_id, str) and request_id:
                return request_id
    return None


def _fingerprint(arguments: Record) -> str:
    text = json.dumps(arguments, sort_keys=True, separators=(",", ":"), default=repr)
    return hashlib.sha256(text.encode()).hexdigest()
