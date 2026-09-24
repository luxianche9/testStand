"""Small shared helpers: record type, absent-value sentinel, time, ids and JSON text."""

from __future__ import annotations

import copy
import json
import math
import time
import uuid
from datetime import UTC, datetime
from typing import Any, TypeAlias, TypeVar

Record: TypeAlias = dict[str, Any]
T = TypeVar("T")


class Undefined:
    """Marks an absent field, distinct from an explicit ``None``."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "undefined"

    def __bool__(self) -> bool:
        return False

    def __copy__(self) -> Undefined:
        return self

    def __deepcopy__(self, memo: dict[int, Any]) -> Undefined:
        return self


UNDEFINED = Undefined()


def clone(value: T) -> T:
    return copy.deepcopy(value)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def iso_from_ms(value: int | float) -> str:
    return (
        datetime.fromtimestamp(value / 1000, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def utc_now_iso() -> str:
    return iso_from_ms(now_ms())


def parse_date_ms(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except (ValueError, OverflowError, OSError):
        return math.nan


def new_uuid() -> str:
    return str(uuid.uuid4())


def json_dumps(value: Any, indent: int | None = None) -> str:
    """Compact UTF-8 JSON by default; absent fields are omitted."""
    return json.dumps(
        _strip_undefined(value),
        ensure_ascii=False,
        allow_nan=False,
        indent=indent,
        separators=None if indent else (",", ":"),
    )


def json_loads(text: str | bytes) -> Any:
    return json.loads(text)


def _strip_undefined(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _strip_undefined(v) for k, v in value.items() if v is not UNDEFINED}
    if isinstance(value, (list, tuple)):
        return [None if item is UNDEFINED else _strip_undefined(item) for item in value]
    return value
