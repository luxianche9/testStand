"""Plain JSON on the wire (HTTP bodies, SSE data) and redacted summaries for the audit log."""

from __future__ import annotations

import base64
import math
from datetime import UTC, datetime
from typing import Any

from hardwareharness_backend.util import UNDEFINED

from .operations import is_sensitive

REDACTED = "[REDACTED]"


def to_json(value: Any) -> Any:
    """JSON-compatible copy: bytes as base64, datetimes as ISO text, ``undefined`` members
    dropped (``null`` in arrays) and non-finite numbers as ``null``."""
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, dict):
        return {str(key): to_json(item) for key, item in value.items() if item is not UNDEFINED}
    if isinstance(value, (list, tuple)):
        return [None if item is UNDEFINED else to_json(item) for item in value]
    if value is UNDEFINED:
        return None
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return to_json(dump(mode="json", by_alias=True))
    raise TypeError(f"Unsupported wire value: {type(value).__name__}")


def summarize(value: Any, *, depth: int = 4, text: int = 200, items: int = 20) -> Any:
    """Redacted, bounded copy for audit records; sensitive keys become ``[REDACTED]``."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(value)} bytes>"
    if isinstance(value, str):
        return value if len(value) <= text else value[:text] + f"...(+{len(value) - text})"
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth <= 0:
        return "..."
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= items:
                result["..."] = f"+{len(value) - items} keys"
                break
            if item is UNDEFINED:
                continue
            name = str(key)
            result[name] = (
                REDACTED
                if is_sensitive(name)
                else summarize(item, depth=depth - 1, text=text, items=items)
            )
        return result
    if isinstance(value, (list, tuple)):
        head = [summarize(item, depth=depth - 1, text=text, items=items) for item in value[:items]]
        return head + ([f"+{len(value) - items} items"] if len(value) > items else [])
    if isinstance(value, datetime):
        return to_json(value)
    return f"<{type(value).__name__}>"
