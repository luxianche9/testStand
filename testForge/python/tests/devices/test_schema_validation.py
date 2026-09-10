from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from testforge_backend.devices.schema_validation import schema_error

CASES = json.loads(Path(__file__).with_name("ajv_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_ajv_errors_text_golden(case: dict[str, Any]) -> None:
    assert schema_error(case["schema"], case["value"]) == case["error"]


@pytest.mark.parametrize(
    ("schema", "value", "expected"),
    [
        (
            {"type": "array", "items": {"type": "number"}, "uniqueItems": True},
            [1, 2, 1],
            "data must NOT have duplicate items (items ## 2 and 0 are identical)",
        ),
        (
            {"type": "string", "nullable": True, "enum": ["a"]},
            None,
            "data must be equal to one of the allowed values",
        ),
        (
            {"additionalProperties": {"type": "number"}},
            {"b": "x", "a": False},
            "data/b must be number, data/a must be number",
        ),
        (
            {"propertyNames": {"minLength": 2}},
            {"a": 1, "b": 2},
            "data must NOT have fewer than 2 characters, data property name must be valid, "
            "data must NOT have fewer than 2 characters, data property name must be valid",
        ),
        (
            {"definitions": {"n": {"type": "number"}}, "$ref": "#/definitions/n", "const": 2},
            "x",
            "data must be number, data must be equal to constant",
        ),
        ({"contains": {"type": "number"}}, ["x", 1], None),
        (
            {"items": [{"type": "number"}], "additionalItems": {"type": "string"}},
            ["x", 3],
            "data/1 must be string, data/0 must be number",
        ),
    ],
)
def test_draft7_edges(schema: dict[str, Any], value: Any, expected: str | None) -> None:
    assert schema_error(schema, value) == expected


@pytest.mark.parametrize(
    ("name", "valid", "invalid"),
    [
        ("email", "a@example.test", "a@localhost"),
        ("date", "2024-02-29", "2023-02-29"),
        ("time", "23:59:60Z", "12:00:00"),
        ("date-time", "2024-02-29 12:00:00+08:00", "2024-02-29T12:00:00"),
        ("iso-time", "12:00:00", "25:00:00"),
        ("uuid", "urn:uuid:12345678-1234-1234-1234-123456789abc", "broken"),
        ("json-pointer", "/a~1b/~0", "/bad~2"),
        ("byte", "YWJj", "!"),
        ("int32", 2147483647, 2147483648),
        ("int64", 2**64, 1.5),
        ("uri", "https://example.test/a?q=1#f", "broken uri"),
        ("uri-reference", "../path?q=1", "broken uri"),
        ("uri-template", "https://example.test/{id}", "{unclosed"),
        ("url", "https://example.test/a", "http://localhost/a"),
        ("ipv4", "192.168.1.1", "192.168.01.1"),
        ("ipv6", "::ffff:192.168.1.1", "1234::1234::1234"),
        ("duration", "P1DT2H", "p1d"),
    ],
)
def test_sdk_formats_are_opt_in(name: str, valid: Any, invalid: Any) -> None:
    assert schema_error({"format": name}, invalid) is None
    assert schema_error({"format": name}, valid, validate_formats=True) is None
    assert schema_error({"format": name}, invalid, validate_formats=True) == (
        f'data must match format "{name}"'
    )
