from __future__ import annotations

import math
from typing import Any

from testforge_backend.compat import UNDEFINED, js_string, json_parse, json_stringify
from testforge_backend.contracts.errors import to_wire_error


def bounded_value(value: Any) -> Any:
    if value is UNDEFINED:
        return UNDEFINED
    try:
        text = json_stringify(value)
        size = len(_utf8(text))
        if size <= 100000:
            return json_parse(text)
        units = text.encode("utf-16-le", "surrogatepass")
        low, high = 0, len(units) // 2
        while low < high:
            middle = (low + high + 1) // 2
            preview = units[: middle * 2].decode("utf-16-le", "surrogatepass")
            if len(_utf8(preview)) <= 4000:
                low = middle
            else:
                high = middle - 1
        return {
            "truncated": True,
            "bytes": size,
            "preview": units[: low * 2].decode("utf-16-le", "surrogatepass"),
        }
    except (ValueError, TypeError, RecursionError):
        return {"unserializable": True, "summary": js_string(value)}


def normalize_error(error: Exception) -> dict[str, Any]:
    normalized = to_wire_error(error)
    category = normalized["category"]
    if category == "error" and getattr(error, "name", None) == "AbortError":
        category = "cancelled"
    bounded = bounded_value(str(error))
    if isinstance(bounded, dict) and bounded.get("truncated") is True:
        return {"category": category, "message": bounded["preview"], "truncation": bounded}
    return {"category": category, "message": bounded if isinstance(bounded, str) else str(error)}


def positive_duration(value: Any, fallback: int) -> int:
    return (
        math.floor(value)
        if type(value) in (int, float) and math.isfinite(value) and value > 0
        else fallback
    )


def _utf8(value: str) -> bytes:
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")
