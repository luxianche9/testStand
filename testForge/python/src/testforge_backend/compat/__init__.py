"""JavaScript value semantics shared by the mechanical backend port."""

from __future__ import annotations

import copy
import json
import math
import re
import time
import uuid
from datetime import UTC, datetime
from typing import Any, TypeAlias, TypeVar

Record: TypeAlias = dict[str, Any]
T = TypeVar("T")


class Undefined:
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
MISSING = UNDEFINED


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


def utf16_compare(left: str, right: str) -> int:
    a = left.encode("utf-16-be", "surrogatepass")
    b = right.encode("utf-16-be", "surrogatepass")
    return (a > b) - (a < b)


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def utf8_bytes(value: str) -> bytes:
    """Node UTF-8 encoding combines valid UTF-16 pairs and replaces lone surrogates."""
    normalized = value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
    return normalized.encode("utf-8")


def js_trim(value: str) -> str:
    return value.strip(
        "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004"
        "\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    )


def js_truthy(value: Any) -> bool:
    if value is UNDEFINED or value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and not math.isnan(float(value))
    return value != "" if isinstance(value, str) else True


def _number_string(value: int | float) -> str:
    try:
        number = float(value)
    except OverflowError:
        number = math.copysign(math.inf, value)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    text = repr(abs(number)).lower()
    coefficient, _, exponent_text = text.partition("e")
    exponent = int(exponent_text) if exponent_text else 0
    whole, _, fraction = coefficient.partition(".")
    digits = (whole + fraction).lstrip("0").rstrip("0")
    decimal_position = len(whole) + exponent
    if whole == "0":
        leading = len(fraction) - len(fraction.lstrip("0"))
        decimal_position = -leading
    if 0 < decimal_position <= 21:
        body = (
            digits + "0" * (decimal_position - len(digits))
            if decimal_position >= len(digits)
            else digits[:decimal_position] + "." + digits[decimal_position:]
        )
    elif -6 < decimal_position <= 0:
        body = "0." + "0" * -decimal_position + digits
    else:
        power = decimal_position - 1
        body = (
            digits[0]
            + ("." + digits[1:] if len(digits) > 1 else "")
            + "e"
            + ("+" if power >= 0 else "-")
            + str(abs(power))
        )
    return sign + body


def js_string(value: Any) -> str:
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return _number_string(value)
    if isinstance(value, (list, tuple)):
        return ",".join(
            "" if item is None or item is UNDEFINED else js_string(item) for item in value
        )
    if isinstance(value, BaseException):
        return f"{getattr(value, 'name', 'Error')}: {value}"
    return "[object Object]"


def js_number(value: Any) -> float:
    if value is UNDEFINED:
        return math.nan
    if value is None:
        return 0.0
    if isinstance(value, (bool, int, float)):
        try:
            return float(value)
        except OverflowError:
            return math.inf if value > 0 else -math.inf
    if isinstance(value, (list, tuple)):
        value = js_string(value)
    if not isinstance(value, str):
        return math.nan
    text = js_trim(value)
    if not text:
        return 0.0
    if re.fullmatch(r"0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+", text):
        return float(int(text, 0))
    if not re.fullmatch(r"[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)", text):
        return math.nan
    return float(text)


def js_strict_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    if isinstance(left, str) and isinstance(right, str):
        return left == right
    return left is right


def js_object_is(left: Any, right: Any) -> bool:
    if (
        isinstance(left, (int, float))
        and not isinstance(left, bool)
        and isinstance(right, (int, float))
        and not isinstance(right, bool)
    ):
        a, b = float(left), float(right)
        if math.isnan(a) and math.isnan(b):
            return True
        if a == b == 0:
            return math.copysign(1, a) == math.copysign(1, b)
    return js_strict_equal(left, right)


def js_remainder(left: Any, right: Any) -> float:
    a, b = js_number(left), js_number(right)
    if math.isnan(a) or math.isnan(b) or math.isinf(a) or b == 0:
        return math.nan
    return a if math.isinf(b) else math.fmod(a, b)


def js_relational_compare(left: Any, right: Any) -> bool | Undefined:
    a = js_string(left) if isinstance(left, (dict, list, tuple)) else left
    b = js_string(right) if isinstance(right, (dict, list, tuple)) else right
    if isinstance(a, str) and isinstance(b, str):
        return utf16_compare(a, b) < 0
    x, y = js_number(a), js_number(b)
    return UNDEFINED if math.isnan(x) or math.isnan(y) else x < y


def js_object_keys(value: Record) -> list[str]:
    indices = [key for key in value if re.fullmatch(r"0|[1-9][0-9]*", key) and int(key) < 2**32 - 1]
    return sorted(indices, key=int) + [key for key in value if key not in indices]


def _quote(value: str) -> str:
    normalized = value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    raw = json.dumps(normalized, ensure_ascii=False)
    return "".join(
        f"\\u{ord(character):04x}" if 0xD800 <= ord(character) <= 0xDFFF else character
        for character in raw
    )


def json_stringify(value: Any, indent: int | None = None) -> str:
    """JSON.stringify spelling; root undefined follows its string interpolation spelling."""
    gap = " " * min(max(indent or 0, 0), 10)
    active: set[int] = set()

    def encode(item: Any, depth: int) -> str:
        if item is UNDEFINED:
            return "undefined"
        if item is None:
            return "null"
        if isinstance(item, bool):
            return "true" if item else "false"
        if isinstance(item, str):
            return _quote(item)
        if isinstance(item, (int, float)):
            number = _number_string(item)
            return "null" if number in ("NaN", "Infinity", "-Infinity") else number
        if isinstance(item, (bytes, bytearray)):
            item = {str(index): element for index, element in enumerate(item)}
        if isinstance(item, (list, tuple, dict)):
            identity = id(item)
            if identity in active:
                raise ValueError("Converting circular structure to JSON")
            active.add(identity)
            try:
                if isinstance(item, dict):
                    fields = [
                        _quote(str(key)) + (": " if gap else ":") + encode(item[key], depth + 1)
                        for key in js_object_keys(item)
                        if item[key] is not UNDEFINED
                    ]
                    opening, closing = "{", "}"
                else:
                    fields = [
                        "null" if element is UNDEFINED else encode(element, depth + 1)
                        for element in item
                    ]
                    opening, closing = "[", "]"
                if not fields:
                    return opening + closing
                if gap:
                    return (
                        opening
                        + "\n"
                        + gap * (depth + 1)
                        + (",\n" + gap * (depth + 1)).join(fields)
                        + "\n"
                        + gap * depth
                        + closing
                    )
                return opening + ",".join(fields) + closing
            finally:
                active.remove(identity)
        raise TypeError(f"Cannot serialize {type(item).__name__}")

    return encode(value, 0)


def json_parse(text: str) -> Any:
    from .json_syntax import syntax_error

    def reject_constant(value: str) -> Any:
        raise ValueError(value)

    def integer(value: str) -> int | float:
        number = float(value)
        if number == 0 and value.startswith("-"):
            return -0.0
        return int(number) if math.isfinite(number) else number

    try:
        return json.loads(text, parse_int=integer, parse_constant=reject_constant)
    except ValueError:
        syntax_error(text)
