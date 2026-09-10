"""Small explicit Zod-compatible validators for the existing wire contracts."""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any

from ada_url import check_url

from testforge_backend.compat import (
    UNDEFINED,
    Record,
    clone,
    js_object_keys,
    js_strict_equal,
    js_string,
    js_trim,
    json_stringify,
    utf8_bytes,
    utf16_length,
)

Path = list[str | int]


class ValidationError(ValueError):
    name = "ZodError"

    def __init__(self, issues: list[Record]) -> None:
        self.issues = issues
        super().__init__(json_stringify(issues, 2))


def _type(value: Any) -> str:
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (int, float)):
        return "nan" if math.isnan(float(value)) else "number"
    if isinstance(value, list):
        return "array"
    return "object"


def custom_issue(message: str, path: Path | None = None) -> Record:
    if path is None:
        return {"code": "custom", "message": message, "path": []}
    return {"code": "custom", "path": path, "message": message}


@dataclass(frozen=True)
class Schema:
    kind: str
    options: Record = field(default_factory=dict)
    optional_value: bool = False
    default_value: Any = UNDEFINED
    nullable_value: bool = False
    catch_value: Any = UNDEFINED
    refinement: Callable[[Any], list[Record]] | None = None

    def optional(self) -> Schema:
        return replace(self, optional_value=True)

    def default(self, value: Any) -> Schema:
        return replace(self, default_value=value)

    def nullable(self) -> Schema:
        return replace(self, nullable_value=True)

    def catch(self, value: Any) -> Schema:
        return replace(self, catch_value=value)

    def refine(self, refinement: Callable[[Any], list[Record]]) -> Schema:
        return replace(self, refinement=refinement)

    def parse(self, value: Any) -> Any:
        issues: list[Record] = []
        result = self._parse(value, [], issues)
        if issues:
            raise ValidationError(issues)
        return result

    def safe_parse(self, value: Any) -> Record:
        try:
            return {"success": True, "data": self.parse(value)}
        except ValidationError as error:
            return {"success": False, "error": error}

    def _parse(self, value: Any, path: Path, issues: list[Record]) -> Any:
        if value is UNDEFINED:
            if self.default_value is not UNDEFINED:
                value = clone(self.default_value)
            elif self.optional_value or self.kind == "unknown":
                return UNDEFINED
        if value is None and self.nullable_value:
            return None
        local: list[Record] = []
        result = self._core(value, path, local)
        if not _aborted(local) and self.refinement:
            for issue in self.refinement(result):
                local.append({**issue, "path": [*path, *issue.get("path", [])]})
        if local and self.catch_value is not UNDEFINED:
            return clone(self.catch_value)
        issues.extend(local)
        return result

    def _core(self, value: Any, path: Path, issues: list[Record]) -> Any:
        options = self.options
        kind = self.kind
        if kind == "unknown":
            return value
        if kind == "lazy":
            schema: Schema = options["factory"]()
            return schema._parse(value, path, issues)
        if kind == "union":
            errors: list[Record] = []
            dirty: tuple[Any, list[Record]] | None = None
            for schema in options["choices"]:
                branch: list[Record] = []
                parsed = schema._parse(value, path, branch)
                if not branch:
                    return parsed
                if dirty is None and not _aborted(branch):
                    dirty = (parsed, branch)
                errors.append({"issues": branch, "name": "ZodError"})
            if dirty is not None:
                issues.extend(dirty[1])
                return dirty[0]
            issues.append(
                {
                    "code": "invalid_union",
                    "unionErrors": errors,
                    "path": path,
                    "message": "Invalid input",
                }
            )
            return UNDEFINED
        if kind == "discriminated":
            if not isinstance(value, dict):
                return self._invalid_type("object", value, path, issues)
            discriminator = options["key"]
            choices: dict[Any, Schema] = options["choices"]
            selected = value.get(discriminator, UNDEFINED)
            match = next(
                (schema for key, schema in choices.items() if js_strict_equal(key, selected)), None
            )
            if match is None:
                expected = list(choices)
                issues.append(
                    {
                        "code": "invalid_union_discriminator",
                        "options": expected,
                        "path": [*path, discriminator],
                        "message": "Invalid discriminator value. Expected "
                        + " | ".join(_literal_display(item) for item in expected),
                    }
                )
                return UNDEFINED
            return match._parse(value, path, issues)
        if kind == "literal":
            expected = options["value"]
            if (
                type(value) is not type(expected)
                and not (_type(value) == _type(expected) == "number")
                or value != expected
            ):
                issues.append(
                    {
                        "received": value,
                        "code": "invalid_literal",
                        "expected": expected,
                        "path": path,
                        "message": f"Invalid literal value, expected {json_stringify(expected)}",
                    }
                )
            return value
        if kind == "enum":
            choices = options["values"]
            if not isinstance(value, str):
                expected_display = " | ".join(_literal_display(item) for item in choices)
                received = _type(value)
                issues.append(
                    {
                        "expected": expected_display,
                        "received": received,
                        "code": "invalid_type",
                        "path": path,
                        "message": "Required"
                        if value is UNDEFINED
                        else f"Expected {expected_display}, received {received}",
                    }
                )
                return UNDEFINED
            if value not in choices:
                issues.append(
                    {
                        "received": value,
                        "code": "invalid_enum_value",
                        "options": choices,
                        "path": path,
                        "message": "Invalid enum value. Expected "
                        + " | ".join(_literal_display(item) for item in choices)
                        + f", received '{value}'",
                    }
                )
            return value
        expected_type = {"record": "object", "object": "object", "bytes": "object"}.get(kind, kind)
        if kind == "bytes":
            if not isinstance(value, (bytes, bytearray)):
                issues.append(
                    {
                        "code": "custom",
                        "message": "Expected Uint8Array",
                        "fatal": True,
                        "path": path,
                    }
                )
            return value
        if _type(value) != expected_type:
            return self._invalid_type(expected_type, value, path, issues)
        if kind == "string":
            if options.get("trim"):
                value = js_trim(value)
            length = utf16_length(value)
            self._bounds(length, "string", path, issues)
            if options.get("regex") and re.search(options["regex"], value) is None:
                issues.append(
                    {
                        "validation": "regex",
                        "code": "invalid_string",
                        "message": "Invalid",
                        "path": path,
                    }
                )
            if options.get("datetime") and not _valid_datetime(value):
                issues.append(
                    {
                        "code": "invalid_string",
                        "validation": "datetime",
                        "message": "Invalid datetime",
                        "path": path,
                    }
                )
            if options.get("url") and not _valid_url(value):
                issues.append(
                    {
                        "validation": "url",
                        "code": "invalid_string",
                        "message": "Invalid url",
                        "path": path,
                    }
                )
            return value
        if kind == "number":
            if options.get("integer") and (not math.isfinite(value) or value != math.trunc(value)):
                issues.append(
                    {
                        "code": "invalid_type",
                        "expected": "integer",
                        "received": "float",
                        "message": "Expected integer, received float",
                        "path": path,
                    }
                )
            self._bounds(value, "number", path, issues)
            if options.get("finite") and not math.isfinite(value):
                issues.append(
                    {"code": "not_finite", "message": "Number must be finite", "path": path}
                )
            return value
        if kind == "boolean":
            return value
        if kind == "array":
            self._bounds(len(value), "array", path, issues)
            element: Schema = options["element"]
            return [
                element._parse(item, [*path, index], issues) for index, item in enumerate(value)
            ]
        if kind == "record":
            element = options["element"]
            parsed_entries = {
                key: element._parse(value[key], [*path, key], issues)
                for key in js_object_keys(value)
            }
            return {key: item for key, item in parsed_entries.items() if key != "__proto__"}
        if kind == "object":
            fields: dict[str, Schema] = options["fields"]
            result: Record = {}
            for key, schema in fields.items():
                parsed = schema._parse(value.get(key, UNDEFINED), [*path, key], issues)
                if parsed is not UNDEFINED or key in value:
                    result[key] = parsed
            extra = [key for key in value if key not in fields]
            if extra and options.get("strict"):
                issues.append(
                    {
                        "code": "unrecognized_keys",
                        "keys": extra,
                        "path": path,
                        "message": "Unrecognized key(s) in object: "
                        + ", ".join(f"'{key}'" for key in extra),
                    }
                )
            return result
        raise RuntimeError(f"Unknown schema kind: {kind}")

    def _invalid_type(self, expected: str, value: Any, path: Path, issues: list[Record]) -> Any:
        received = _type(value)
        issues.append(
            {
                "code": "invalid_type",
                "expected": expected,
                "received": received,
                "path": path,
                "message": "Required"
                if value is UNDEFINED
                else f"Expected {expected}, received {received}",
            }
        )
        return UNDEFINED

    def _bounds(self, value: int | float, kind: str, path: Path, issues: list[Record]) -> None:
        for key, code in (("minimum", "too_small"), ("maximum", "too_big")):
            bound = self.options.get(key)
            inclusive = not (key == "minimum" and self.options.get("positive"))
            if bound is None or not (
                value < bound or (not inclusive and value == bound)
                if key == "minimum"
                else value > bound
            ):
                continue
            if kind == "number":
                comparison = "greater than" if key == "minimum" else "less than"
                equality = " or equal to" if inclusive else ""
                message = f"Number must be {comparison}{equality} {js_string(bound)}"
            else:
                noun = "String" if kind == "string" else "Array"
                unit = "character(s)" if kind == "string" else "element(s)"
                comparison = "at least" if key == "minimum" else "at most"
                message = f"{noun} must contain {comparison} {bound} {unit}"
            issues.append(
                {
                    "code": code,
                    key: bound,
                    "type": kind,
                    "inclusive": inclusive,
                    "exact": False,
                    "message": message,
                    "path": path,
                }
            )


def _literal_display(value: Any) -> str:
    return f"'{value}'" if isinstance(value, str) else js_string(value)


def _aborted(issues: list[Record]) -> bool:
    for issue in issues:
        if issue.get("fatal"):
            return True
        code = issue["code"]
        if code == "invalid_type" and issue.get("expected") != "integer":
            return True
        if code in (
            "invalid_literal",
            "invalid_enum_value",
            "invalid_union_discriminator",
            "invalid_union",
        ):
            return True
    return False


def _valid_datetime(value: str) -> bool:
    match = re.fullmatch(
        r"(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?Z", value
    )
    if not match:
        return False
    try:
        date(int(match[1]) or 400, int(match[2]), int(match[3]))
        return True
    except ValueError:
        return False


def _valid_url(value: str) -> bool:
    # ada-url 1.15.3 embeds Ada 2.9.2, matching Electron 36 / Node 22.19.
    # URL construction first converts a JavaScript string to a USVString.
    return check_url(utf8_bytes(value).decode("utf-8"))


def string(
    minimum: int | None = None,
    maximum: int | None = None,
    *,
    trim: bool = False,
    regex: str | None = None,
    datetime: bool = False,
    url: bool = False,
) -> Schema:
    return Schema(
        "string",
        {
            "minimum": minimum,
            "maximum": maximum,
            "trim": trim,
            "regex": regex,
            "datetime": datetime,
            "url": url,
        },
    )


def number(
    minimum: int | float | None = None,
    maximum: int | float | None = None,
    *,
    integer: bool = False,
    finite: bool = False,
    positive: bool = False,
) -> Schema:
    return Schema(
        "number",
        {
            "minimum": 0 if positive else minimum,
            "maximum": maximum,
            "integer": integer,
            "finite": finite,
            "positive": positive,
        },
    )


def boolean() -> Schema:
    return Schema("boolean")


def literal(value: Any) -> Schema:
    return Schema("literal", {"value": value})


def enum(*values: str) -> Schema:
    return Schema("enum", {"values": list(values)})


def array(element: Schema, minimum: int | None = None, maximum: int | None = None) -> Schema:
    return Schema("array", {"element": element, "minimum": minimum, "maximum": maximum})


def record(element: Schema) -> Schema:
    return Schema("record", {"element": element})


def obj(fields: dict[str, Schema], *, strict: bool = False) -> Schema:
    return Schema("object", {"fields": fields, "strict": strict})


def unknown() -> Schema:
    return Schema("unknown")


def lazy(factory: Callable[[], Schema]) -> Schema:
    return Schema("lazy", {"factory": factory})


def union(*choices: Schema) -> Schema:
    return Schema("union", {"choices": choices})


def discriminated(key: str, choices: dict[Any, Schema]) -> Schema:
    return Schema("discriminated", {"key": key, "choices": choices})


def parse_record(schema: Schema, value: Any) -> Record:
    parsed = schema.parse(value)
    if not isinstance(parsed, dict):
        raise TypeError("Expected an object schema")
    return parsed


id_input_schema = obj({"id": string(1)}, strict=True)


def parse_id_input(value: Any) -> Record:
    return parse_record(id_input_schema, value)
