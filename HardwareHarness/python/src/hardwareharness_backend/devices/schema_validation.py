"""Draft-7 validation with the desktop's Ajv 8 allErrors/errorsText behavior."""

from __future__ import annotations

import math
import re
from collections.abc import Iterator
from typing import Any, cast

from jsonschema import Draft7Validator, FormatChecker, validators
from jsonschema.exceptions import ValidationError

from hardwareharness_backend.compat import js_object_keys, js_string

Schema = dict[str, Any] | bool
_ORDER = (
    "$ref",
    "type",
    "const",
    "enum",
    "not",
    "anyOf",
    "oneOf",
    "allOf",
    "if",
    "maximum",
    "minimum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "multipleOf",
    "maxLength",
    "minLength",
    "pattern",
    "format",
    "maxItems",
    "minItems",
    "additionalItems",
    "items",
    "contains",
    "uniqueItems",
    "maxProperties",
    "minProperties",
    "required",
    "propertyNames",
    "additionalProperties",
    "dependencies",
    "properties",
    "patternProperties",
)
_SINGLE = {
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
    "additionalProperties",
    "additionalItems",
}
_MAPPINGS = {"properties", "patternProperties", "definitions", "$defs", "dependencies"}


def _ordered(schema: Schema) -> Schema:
    if isinstance(schema, bool):
        return schema
    result: dict[str, Any] = {}
    for key in dict.fromkeys((*_ORDER, *schema)):
        if key not in schema or key in {"$schema", "nullable"}:
            continue
        value = schema[key]
        if key in _SINGLE:
            value = _ordered(value)
        elif key in _MAPPINGS:
            value = {
                name: _ordered(item) if isinstance(item, (dict, bool)) else item
                for name, item in value.items()
            }
        elif key in {"anyOf", "oneOf", "allOf", "items"}:
            value = (
                [_ordered(item) for item in value] if isinstance(value, list) else _ordered(value)
            )
        if key == "type" and schema.get("nullable") is True:
            value = [value] if isinstance(value, str) else list(value)
            if "null" not in value:
                value.append("null")
        result[key] = value
    return result


def _contains(
    validator: Any, value: Schema, instance: Any, schema: Schema
) -> Iterator[ValidationError]:
    if not isinstance(instance, list):
        return
    errors = []
    for index, item in enumerate(instance):
        current = list(validator.descend(item, value, path=index))
        if not current:
            return
        errors.extend(current)
    yield from errors
    yield ValidationError("must contain at least 1 valid item(s)")


def _if(
    validator: Any, value: Schema, instance: Any, schema: dict[str, Any]
) -> Iterator[ValidationError]:
    branch = "then" if validator.evolve(schema=value).is_valid(instance) else "else"
    if branch in schema:
        errors = list(validator.descend(instance, schema[branch], schema_path=branch))
        if errors:
            yield from errors
            yield ValidationError(f'must match "{branch}" schema')


def _property_names(
    validator: Any, value: Schema, instance: Any, schema: Schema
) -> Iterator[ValidationError]:
    if isinstance(instance, dict):
        for name in js_object_keys(instance):
            errors = list(validator.descend(name, value))
            if errors:
                yield from errors
                yield ValidationError("property name must be valid")


def _additional(
    validator: Any, value: Schema, instance: Any, schema: dict[str, Any]
) -> Iterator[ValidationError]:
    if not isinstance(instance, dict):
        return
    for name in js_object_keys(instance):
        if name in schema.get("properties", {}) or any(
            re.search(pattern, name) for pattern in schema.get("patternProperties", {})
        ):
            continue
        if value is False:
            yield ValidationError("must NOT have additional properties")
        elif isinstance(value, dict):
            yield from validator.descend(instance[name], value, path=name)


def _dependencies(
    validator: Any, value: dict[str, Any], instance: Any, schema: Schema
) -> Iterator[ValidationError]:
    if not isinstance(instance, dict):
        return
    # Ajv compiles property dependencies before schema dependencies.
    for name in js_object_keys(value):
        dependents = value[name]
        if name in instance and isinstance(dependents, list):
            for dependent in dependents:
                if dependent not in instance:
                    names = ", ".join(dependents)
                    singular = len(dependents) == 1
                    message = (
                        f"must have property {names} when property {name} is present"
                        if singular
                        else f"must have properties {names} when property {name} is present"
                    )
                    yield ValidationError(message)
    for name in js_object_keys(value):
        if name in instance and not isinstance(value[name], list):
            yield from validator.descend(instance, value[name], schema_path=name)


def _required(
    validator: Any, value: list[str], instance: Any, schema: Schema
) -> Iterator[ValidationError]:
    if isinstance(instance, dict):
        for name in value:
            if name not in instance:
                yield ValidationError(f"must have required property '{name}'")


def _equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _equal(a, b) for a, b in zip(left, right, strict=True)
        )
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_equal(left[key], right[key]) for key in left)
    return type(left) is type(right) and left == right


def _unique(
    validator: Any, value: bool, instance: Any, schema: dict[str, Any]
) -> Iterator[ValidationError]:
    if not value or not isinstance(instance, list):
        return
    item_schema = schema.get("items", {})
    item_type = item_schema.get("type", []) if isinstance(item_schema, dict) else []
    types = [item_type] if isinstance(item_type, str) else item_type
    optimized = bool(types) and not any(name in {"object", "array"} for name in types)
    for index in range(len(instance) - 1, -1, -1):
        if optimized and not any(validator.is_type(instance[index], name) for name in types):
            continue
        others = range(len(instance) - 1, index, -1) if optimized else range(index - 1, -1, -1)
        for other in others:
            if _equal(instance[index], instance[other]):
                yield ValidationError(
                    f"must NOT have duplicate items (items ## {other} and {index} are identical)"
                )
                return


def _date(value: str) -> bool:
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        return False
    year, month, day = map(int, value.split("-"))
    days = [
        0,
        31,
        29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ]
    return 1 <= month <= 12 and 1 <= day <= days[month]


def _time(value: str, strict: bool) -> bool:
    match = re.fullmatch(
        r"([0-9]{2}):([0-9]{2}):([0-9]{2}(?:\.[0-9]+)?)(z|([+-])([0-9]{2})(?::?([0-9]{2}))?)?",
        value,
        re.I,
    )
    if not match:
        return False
    hour, minute, second = float(match[1]), float(match[2]), float(match[3])
    tz_hour, tz_minute = int(match[6] or 0), int(match[7] or 0)
    if tz_hour > 23 or tz_minute > 59 or (strict and not match[4]):
        return False
    if hour <= 23 and minute <= 59 and second < 60:
        return True
    sign = -1 if match[5] == "-" else 1
    utc_minute = minute - tz_minute * sign
    utc_hour = hour - tz_hour * sign - (1 if utc_minute < 0 else 0)
    return utc_hour in {23, -1} and utc_minute in {59, -1} and second < 61


_FORMAT_PATTERNS = {
    "uri-reference": (
        "(?:[a-z][a-z0-9+\\-.]*:)?(?:\\/?\\/(?:(?:[a-z0-9\\-._~!$&'()*+,;=:]|%"
        "[0-9a-f]{2})*@)?(?:\\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]"
        "{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-"
        "f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-"
        "f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-"
        "f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}"
        ":){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25["
        "0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?))|("
        "?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-"
        "9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\\.[a-z0-9\\-._~!$"
        "&'()*+,;=:]+)\\]|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5"
        "]|2[0-4]\\d|[01]?\\d\\d?)|(?:[a-z0-9\\-._~!$&'\"()*+,;=]|%[0-9a-f]{2})"
        "*)(?::\\d*)?(?:\\/(?:[a-z0-9\\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})*)*|\\"
        "/(?:(?:[a-z0-9\\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})+(?:\\/(?:[a-z0-9\\"
        "-._~!$&'\"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\\-._~!$&'\"()*+,;"
        "=:@]|%[0-9a-f]{2})+(?:\\/(?:[a-z0-9\\-._~!$&'\"()*+,;=:@]|%[0-9a-f]{"
        "2})*)*)?(?:\\?(?:[a-z0-9\\-._~!$&'\"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:"
        "#(?:[a-z0-9\\-._~!$&'\"()*+,;=:@/?]|%[0-9a-f]{2})*)?"
    ),
    "uri-template": (
        "(?:(?:[^\\x00-\\x20\"'<>%\\\\^`{|}]|%[0-9a-f]{2})|\\{[+#./;?&=,!@|]?(?:"
        "[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\\*)?(?:,(?:[a-z0-9_]|"
        "%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\\*)?)*\\})*"
    ),
    "url": (
        "(?:https?|ftp):\\/\\/(?:\\S+(?::\\S*)?@)?(?:(?!(?:10|127)(?:\\.\\d{1,3}"
        "){3})(?!(?:169\\.254|192\\.168)(?:\\.\\d{1,3}){2})(?!172\\.(?:1[6-9]|2"
        "\\d|3[0-1])(?:\\.\\d{1,3}){2})(?:[1-9]\\d?|1\\d\\d|2[01]\\d|22[0-3])(?:\\"
        ".(?:1?\\d{1,2}|2[0-4]\\d|25[0-5])){2}(?:\\.(?:[1-9]\\d?|1\\d\\d|2[0-4]\\"
        "d|25[0-4]))|(?:(?:[a-z0-9\\u00a1-\\uffff]+-)*[a-z0-9\\u00a1-\\uffff]+"
        ")(?:\\.(?:[a-z0-9\\u00a1-\\uffff]+-)*[a-z0-9\\u00a1-\\uffff]+)*(?:\\.(?"
        ":[a-z\\u00a1-\\uffff]{2,})))(?::\\d{2,5})?(?:\\/[^\\s]*)?"
    ),
    "ipv4": (
        "(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"
    ),
    "ipv6": (
        "((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-"
        "9a-f]{1,4}|((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d"
        "|1\\d\\d|[1-9]?\\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){"
        "1,2})|:((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d"
        "\\d|[1-9]?\\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3}"
        ")|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5"
        "]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9"
        "a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\\d|1\\d\\d|"
        "[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}))|:))|(([0-9a-f"
        "]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0"
        "-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d))"
        "{3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f"
        "]{1,4}){0,4}:((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]"
        "\\d|1\\d\\d|[1-9]?\\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-"
        "f]{1,4}){0,5}:((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4"
        "]\\d|1\\d\\d|[1-9]?\\d)){3}))|:)))"
    ),
    "uri": (
        "(?:[a-z][a-z0-9+\\-.]*:)(?:\\/?\\/(?:(?:[a-z0-9\\-._~!$&'()*+,;=:]|%["
        "0-9a-f]{2})*@)?(?:\\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{"
        "1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f"
        "]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f"
        "]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f"
        "]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:"
        "){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0"
        "-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?))|(?"
        ":(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9"
        "a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\\.[a-z0-9\\-._~!$&"
        "'()*+,;=:]+)\\]|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]"
        "|2[0-4]\\d|[01]?\\d\\d?)|(?:[a-z0-9\\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)"
        "(?::\\d*)?(?:\\/(?:[a-z0-9\\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\\/(?"
        ":(?:[a-z0-9\\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\\/(?:[a-z0-9\\-._~"
        "!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\\-._~!$&'()*+,;=:@]|%"
        "[0-9a-f]{2})+(?:\\/(?:[a-z0-9\\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)"
        "(?:\\?(?:[a-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0"
        "-9\\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?"
    ),
    "email": (
        r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@"
        r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
    ),
    "hostname": (
        r"(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
        r"(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?"
    ),
    "uuid": r"(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}",
    "json-pointer": r"(?:/(?:[^~/]|~0|~1)*)*",
    "json-pointer-uri-fragment": r"#(?:/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*",
    "relative-json-pointer": r"(?:0|[1-9][0-9]*)(?:#|(?:/(?:[^~/]|~0|~1)*)*)",
    "duration": (
        r"P(?!$)(([0-9]+Y)?([0-9]+M)?([0-9]+D)?"
        r"(T(?=[0-9])([0-9]+H)?([0-9]+M)?([0-9]+S)?)?|([0-9]+W)?)"
    ),
}
_CHECKER = FormatChecker()


def _format_valid(name: str, value: Any) -> bool:
    if name in {"int32", "int64", "float", "double"}:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return True
        if name in {"float", "double"}:
            return True
        return (
            math.isfinite(value)
            and float(value).is_integer()
            and (name == "int64" or -(2**31) <= value < 2**31)
        )
    if not isinstance(value, str):
        return True
    if name in _FORMAT_PATTERNS:
        flags = re.ASCII if name == "duration" else re.I | re.ASCII
        return re.fullmatch(_FORMAT_PATTERNS[name], value, flags) is not None
    if name == "date":
        return _date(value)
    if name in {"time", "iso-time"}:
        return _time(value, name == "time")
    if name in {"date-time", "iso-date-time"}:
        parts = re.split(r"[t\s]", value, flags=re.I)
        return len(parts) == 2 and _date(parts[0]) and _time(parts[1], name == "date-time")
    if name == "byte":
        return (
            re.search(
                r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$", value, re.M
            )
            is not None
        )
    return _CHECKER.conforms(value, name)


def _format(validator: Any, value: str, instance: Any, schema: Schema) -> Iterator[ValidationError]:
    if not _format_valid(value, instance):
        yield ValidationError(f'must match format "{value}"')


_VALIDATORS: dict[str, Any] = dict(Draft7Validator.VALIDATORS)
_VALIDATORS.update(
    {
        "contains": _contains,
        "if": _if,
        "propertyNames": _property_names,
        "additionalProperties": _additional,
        "dependencies": _dependencies,
        "required": _required,
        "uniqueItems": _unique,
    }
)
_AJV = validators.create(
    Draft7Validator.META_SCHEMA, _VALIDATORS, type_checker=Draft7Validator.TYPE_CHECKER
)
_FORMAT_VALIDATORS: dict[str, Any] = {**_VALIDATORS, "format": _format}
_AJV_FORMATS = validators.create(
    Draft7Validator.META_SCHEMA,
    _FORMAT_VALIDATORS,
    type_checker=Draft7Validator.TYPE_CHECKER,
)


def _message(error: ValidationError) -> str:
    keyword, value = error.validator, error.validator_value
    if error.message.startswith(("must ", "property name ")):
        return error.message
    if keyword is None and error.schema is False:
        return "boolean schema is false"
    if keyword == "type":
        return "must be " + (",".join(value) if isinstance(value, list) else str(value))
    simple = {
        "const": "must be equal to constant",
        "enum": "must be equal to one of the allowed values",
        "not": "must NOT be valid",
        "anyOf": "must match a schema in anyOf",
        "oneOf": "must match exactly one schema in oneOf",
    }
    if keyword in simple:
        return simple[keyword]
    operators = {"maximum": "<=", "minimum": ">=", "exclusiveMaximum": "<", "exclusiveMinimum": ">"}
    if keyword in operators:
        return f"must be {operators[keyword]} {js_string(value)}"
    if keyword == "multipleOf":
        return f"must be multiple of {js_string(value)}"
    if keyword in {
        "maxLength",
        "minLength",
        "maxItems",
        "minItems",
        "maxProperties",
        "minProperties",
    }:
        unit = {"Length": "characters", "Items": "items", "Properties": "properties"}[
            str(keyword)[3:]
        ]
        bound = "more" if str(keyword).startswith("max") else "fewer"
        return f"must NOT have {bound} than {value} {unit}"
    if keyword == "additionalItems":
        schema = cast(dict[str, Any], error.schema)
        return f"must NOT have more than {len(schema['items'])} items"
    if keyword == "pattern":
        return f'must match pattern "{value}"'
    if keyword == "format":
        return f'must match format "{value}"'
    return error.message


def _errors(error: ValidationError) -> Iterator[str]:
    for nested in error.context:
        yield from _errors(nested)
    path = "".join(
        "/" + str(part).replace("~", "~0").replace("/", "~1") for part in error.absolute_path
    )
    yield "data" + path + " " + _message(error)


def schema_error(schema: Schema, value: Any, *, validate_formats: bool = False) -> str | None:
    validator = (_AJV_FORMATS if validate_formats else _AJV)(_ordered(schema))
    errors = [message for error in validator.iter_errors(value) for message in _errors(error)]
    return ", ".join(errors) if errors else None
