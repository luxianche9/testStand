"""Hardware calls and structured execution logging for HardwareHarness Python programs."""

from __future__ import annotations

import asyncio
import contextvars
import functools
import inspect
import json
import time
import traceback
import uuid
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from types import TracebackType
from typing import Any, Literal, ParamSpec, TypeVar, cast

from . import _transport

__all__ = ["call", "acall", "step", "log", "measurement", "attachment"]

_span: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "hardwareharness_span", default=None
)
P = ParamSpec("P")
R = TypeVar("R")
__version__ = "0.1.0"
__contract_revision__ = "2026-09-15.1"


def _result(value: Any, mode: Literal["envelope", "data"]) -> Any:
    """Select a business result after the runner has retained its original evidence."""
    if mode == "envelope":
        return value
    if not isinstance(value, dict):
        return value
    if value.get("isError") is True:
        raise _transport.HardwareHarnessError("device_error", "Hardware tool failed", value)
    selected = value.get("structuredContent", value)
    if selected is value and isinstance(value.get("content"), list):
        texts = [item.get("text", "") for item in value["content"] if item.get("type") == "text"]
        if len(texts) == 1:
            with suppress(ValueError, TypeError):
                selected = json.loads(texts[0])
    if isinstance(selected, dict) and selected.get("ok") is False:
        raise _transport.HardwareHarnessError("device_error", "Hardware tool failed", selected)
    if isinstance(selected, dict) and selected.get("ok") is True and "data" in selected:
        return selected["data"]
    return selected


def _check_result_mode(mode: str) -> None:
    if mode not in {"envelope", "data"}:
        raise ValueError("result_mode must be 'envelope' or 'data'")


def _source() -> dict[str, Any]:
    frame = inspect.currentframe()
    try:
        while frame:
            filename = frame.f_code.co_filename
            if filename != __file__:
                return {"path": filename, "line": frame.f_lineno}
            frame = frame.f_back
        return {}
    finally:
        del frame


def _event(kind: str, data: dict[str, Any], **identity: Any) -> None:
    _transport.request("event", {"type": kind, "spanId": _span.get(), "data": data, **identity})


def call(
    hardware_id: str,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    timeout_ms: int | None = None,
    result_mode: Literal["envelope", "data"] = "envelope",
) -> Any:
    """Invoke a declared tool. Default preserves MCP; data selects its business value."""
    _check_result_mode(result_mode)
    response = _transport.request(
        "call",
        {
            "hardwareId": hardware_id,
            "toolName": tool_name,
            "arguments": arguments,
            "timeoutMs": timeout_ms,
            "parentSpanId": _span.get(),
            "source": _source(),
        },
    )
    return _result(response, result_mode)


async def acall(
    hardware_id: str,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    timeout_ms: int | None = None,
    result_mode: Literal["envelope", "data"] = "envelope",
) -> Any:
    """Asynchronous equivalent of :func:`call`; no hardware request is replayed."""
    _check_result_mode(result_mode)
    response = await asyncio.to_thread(
        _transport.request,
        "call",
        {
            "hardwareId": hardware_id,
            "toolName": tool_name,
            "arguments": arguments,
            "timeoutMs": timeout_ms,
            "parentSpanId": _span.get(),
            "source": _source(),
        },
    )
    return _result(response, result_mode)


class _Step:
    def __init__(self, name: str) -> None:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Step name must be a non-empty string")
        self.name = name
        self.token: contextvars.Token[str | None] | None = None
        self.started = 0.0
        self.span_id = ""

    def __enter__(self) -> _Step:
        if self.token is not None:
            raise RuntimeError("Use a separate step block for each concurrent invocation")
        self.span_id = uuid.uuid4().hex
        _event(
            "step.started",
            {"source": _source()},
            spanId=self.span_id,
            parentSpanId=_span.get(),
            name=self.name,
        )
        self.token = _span.set(self.span_id)
        self.started = time.perf_counter()
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        assert self.token is not None, "Step exit requires an entered block"
        data: dict[str, Any] = {
            "status": "failed" if error else "succeeded",
            "durationMs": round((time.perf_counter() - self.started) * 1000),
        }
        if error:
            data["error"] = {
                "message": str(error),
                "traceback": "".join(traceback.format_exception(kind, error, tb)),
            }
        try:
            _event("step.completed", data, name=self.name)
        finally:
            _span.reset(self.token)
            self.token = None

    async def __aenter__(self) -> _Step:
        return self.__enter__()

    async def __aexit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.__exit__(kind, error, tb)

    def __call__(self, function: Callable[P, R]) -> Callable[P, R]:
        if inspect.iscoroutinefunction(function):

            @functools.wraps(function)
            async def async_wrapper(*args: P.args, **kwargs: P.kwargs) -> Any:
                async with _Step(self.name):
                    return await function(*args, **kwargs)

            return cast(Callable[P, R], async_wrapper)

        @functools.wraps(function)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with _Step(self.name):
                return function(*args, **kwargs)

        return wrapper


def step(name: str) -> _Step:
    """Mark a business step as a decorator or a sync/async context manager."""
    return _Step(name)


def log(message: str, *, level: str = "info", fields: dict[str, Any] | None = None) -> None:
    _event("log", {"message": message, "level": level, "fields": fields or {}, "source": _source()})


def measurement(name: str, value: float | int, *, unit: str | None = None) -> None:
    _event("measurement", {"name": name, "value": value, "unit": unit, "source": _source()})


def attachment(path: str | Path, *, name: str | None = None, media_type: str | None = None) -> None:
    _transport.request(
        "attachment",
        {
            "path": str(Path(path).resolve()),
            "name": name,
            "mediaType": media_type,
            "spanId": _span.get(),
        },
    )
