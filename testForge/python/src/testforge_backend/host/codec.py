"""Unambiguous tagged values for the existing structured-clone facade."""

from __future__ import annotations

import base64
import math
from datetime import UTC, datetime
from typing import Any

from testforge_backend.compat import UNDEFINED


def encode(value: Any) -> list[Any]:
    if value is UNDEFINED:
        return ["undefined"]
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["boolean", value]
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            if math.isnan(value):
                return ["number", "nan"]
            if math.isinf(value):
                return ["number", "infinity" if value > 0 else "-infinity"]
            if value == 0 and math.copysign(1, value) < 0:
                return ["number", "-zero"]
        return ["number", value]
    if isinstance(value, str):
        return ["string", value]
    if isinstance(value, (bytes, bytearray, memoryview)):
        return ["bytes", base64.b64encode(value).decode("ascii")]
    if isinstance(value, datetime):
        return [
            "date",
            value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        ]
    if isinstance(value, (list, tuple)):
        return ["array", [encode(item) for item in value]]
    if isinstance(value, dict):
        return ["object", [[str(key), encode(item)] for key, item in value.items()]]
    raise TypeError(f"Unsupported process value: {type(value).__name__}")


def decode(value: Any) -> Any:
    if not isinstance(value, list) or not value or not isinstance(value[0], str):
        raise ValueError("Invalid process value")
    tag = value[0]
    if tag in {"null", "undefined"} and len(value) == 1:
        return None if tag == "null" else UNDEFINED
    if len(value) != 2:
        raise ValueError("Invalid process value length")
    data = value[1]
    if tag == "boolean" and isinstance(data, bool):
        return data
    if tag == "string" and isinstance(data, str):
        return data
    if tag == "number":
        if isinstance(data, (int, float)) and not isinstance(data, bool):
            return data
        if isinstance(data, str) and data in {"nan", "infinity", "-infinity", "-zero"}:
            return {"nan": math.nan, "infinity": math.inf, "-infinity": -math.inf, "-zero": -0.0}[
                data
            ]
    if tag == "bytes" and isinstance(data, str):
        return base64.b64decode(data, validate=True)
    if tag == "date" and isinstance(data, str):
        return datetime.fromisoformat(data.replace("Z", "+00:00"))
    if tag == "array" and isinstance(data, list):
        return [decode(item) for item in data]
    if tag == "object" and isinstance(data, list):
        result: dict[str, Any] = {}
        for item in data:
            if not isinstance(item, list) or len(item) != 2 or not isinstance(item[0], str):
                raise ValueError("Invalid process object entry")
            result[item[0]] = decode(item[1])
        return result
    raise ValueError(f"Invalid process value tag: {tag}")
