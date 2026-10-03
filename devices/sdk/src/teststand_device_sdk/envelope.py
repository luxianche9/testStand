"""Versioned public result envelope shared by every tool of an SDK device."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, create_model, model_serializer, model_validator

from .errors import INTERNAL, RETRYABLE_CATEGORIES, DeviceError

CONTRACT_REVISION = "2026-10-01.1"
TIMEOUT_RECOVERY = (
    "Query current status/evidence before replaying any physical action; "
    "an RPC timeout does not prove non-execution."
)
ERROR_RECOVERY = (
    "Read get_hardware_info for current availability. Inspect error.details for partial effects; "
    "a failed or timed-out write does not prove no actuation. Correct invalid parameters before a new action."
)

log = logging.getLogger("teststand_device_sdk")


def iso_now() -> str:
    return datetime.now(UTC).isoformat()


class ContractModel(BaseModel):
    # Keep vendor extensions, explicit nulls and existing omitted-field behavior.
    model_config = ConfigDict(extra="allow")

    @model_serializer(mode="wrap")
    def preserve_shape(self, handler: Any) -> Any:
        values = handler(self)
        return {key: value for key, value in values.items()
                if key in self.model_fields_set or key in (self.model_extra or {})}


def model(model_name: str, **fields: tuple[Any, ...]) -> type[ContractModel]:
    """(type, description[, default]) declarations generate schemas and validation."""
    return create_model(model_name, __base__=ContractModel, **{  # type: ignore[call-overload,no-any-return]
        key: (spec[0] | None if len(spec) > 2 and spec[2] is None else spec[0],
              Field(default=spec[2] if len(spec) > 2 else ..., description=spec[1]))
        for key, spec in fields.items()
    })


Error = model("ToolError", category=(str, "Stable error category."), message=(str, "Failure and recovery detail."),
              retryable=(bool, "Transport retry advice only; never authorizes replaying a physical action.", False),
              details=(Any, "Original driver detail, including partial results when available.", None),
              recovery=(str, "Next evidence to obtain before retrying.", None))
StreamRef = model("StreamRef", streamId=(str, "Stream the call appended to."),
                  fromSeq=(int, "First appended sequence number."), toSeq=(int, "Last appended sequence number."))
Timing = model("ToolTiming", start=(float, "Service clock (Unix ms) when driver work began."),
               end=(float, "Service clock (Unix ms) when driver work ended; the anchor of this call."))
Meta = model("ToolMeta", timestamp=(str, "UTC response observation time in ISO 8601."),
             operationId=(str, "Operation this call ran under (_meta.operationId or host-generated).", None),
             timing=(Timing, "Driver work interval on the service clock.", None),
             streamRefs=(list[StreamRef], "Stream records appended during the call, tagged with op.", None))


def envelope(name: str, data_type: Any) -> type[ContractModel]:
    class Response(ContractModel):
        ok: bool = Field(description="Business success; inspect error when false.")
        message: str = Field(default="", description="Optional human-readable context.")
        data: data_type | None = Field(default=None, description="Tool-specific successful result.")
        error: Error | None = None  # type: ignore[valid-type]
        meta: Meta  # type: ignore[valid-type]

        @model_validator(mode="after")
        def required_branch(self) -> Response:
            if self.ok and "data" not in self.model_fields_set:
                raise ValueError("Successful response requires data")
            if not self.ok and self.error is None:
                raise ValueError("Failed response requires error")
            return self
    Response.__name__ = Response.__qualname__ = name + "Response"
    return Response


def ok(data: Any, message: str = "", meta: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"ok": True, "message": message, "data": data, "meta": {"timestamp": iso_now(), **(meta or {})}}


def error(exc: BaseException, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    if isinstance(exc, DeviceError):
        category, details = exc.category, exc.details
    else:
        category, details = INTERNAL, None
        log.error("Unhandled tool error", exc_info=exc)
    return {"ok": False, "error": {"category": category, "message": str(exc), "retryable": category in RETRYABLE_CATEGORIES,
            "details": details, "recovery": ERROR_RECOVERY}, "meta": {"timestamp": iso_now(), **(meta or {})}}
