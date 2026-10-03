"""§7.3 expression language: functions, operators and compile-time checks."""

from __future__ import annotations

from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.testing.expression import check, evaluate
from teststand_backend.testing.models import empty_plan
from teststand_backend.testing.validation import validate_plan

CONTEXT: dict[str, Any] = {
    "parameters": {"limit": 3, "name": "dut-01", "raw": "0a0b0c0d"},
    "variables": {"values": [3, 1, 2], "flags": [True, False]},
    "steps": {"read": {"result": {"code": "0x1f", "text": " OK,42 "}}},
    "item": None,
    "index": 0,
}


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("abs(-2.5)", 2.5),
        ("min(3, 1, 2)", 1),
        ("max(variables.values)", 3),
        ("round(3.14159, 2)", 3.14),
        ("floor(2.7) + ceil(2.1)", 5),
        ("sqrt(16.0)", 4.0),
        ("int('ff', 16)", 255),
        ("int(steps.read.result.code, 16)", 31),
        ("int(2.9)", 2),
        ("float('1.5') * 2", 3.0),
        ("str(42) + 'V'", "42V"),
        ("hex(255)", "0xff"),
        ("len(variables.values) == 3", True),
        ("sum(variables.values)", 6),
        ("all(variables.flags)", False),
        ("any(variables.flags)", True),
        ("sorted(variables.values)", [1, 2, 3]),
        ("0b1100 & 0b1010", 0b1000),
        ("0b1100 | 0b0011", 0b1111),
        ("6 ^ 3", 5),
        ("1 << 4", 16),
        ("256 >> 4", 16),
        ("~0", -1),
        ("bit(0b100, 2)", 1),
        ("bits(0xabcd, 4, 11)", 0xBC),
        ("bytes_hex(parameters.raw)", "0a0b0c0d"),
        ("u16le(parameters.raw, 0)", 0x0B0A),
        ("u16be(parameters.raw, 2)", 0x0C0D),
        ("u32le(parameters.raw, 0)", 0x0D0C0B0A),
        ("u8(parameters.raw, 3)", 13),
        ("startsWith(parameters.name, 'dut')", True),
        ("parameters.name.endsWith('01')", True),
        ("contains(parameters.name, '-')", True),
        ("matches(parameters.name, '^dut-[0-9]+$')", True),
        ("split(trim(steps.read.result.text), ',')", ["OK", "42"]),
        ("int(split(trim(steps.read.result.text), ',')[1]) > parameters.limit", True),
        ("parameters.name == 'a && !b' || true", True),
        ("'x != y' == 'x != y' && !false", True),
    ],
)
def test_functions_and_operators(expression: str, expected: Any) -> None:
    assert evaluate(expression, CONTEXT) == expected
    assert check(expression) == []


@pytest.mark.parametrize(
    ("expression", "code", "fragment"),
    [
        ("open('x')", "expression.unknown_function", "open"),
        ("time()", "expression.unknown_function", "time"),
        ("abs(1, 2)", "expression.arity", "abs() takes 1 argument"),
        ("round()", "expression.arity", "round"),
        ("abs('x')", "expression.type", "abs() argument 1"),
        ("1 & 1.5", "expression.type", "&"),
        ("~'a'", "expression.type", "~"),
        ("'a' - 1", "expression.type", "-"),
        ("len(3)", "expression.type", "len"),
        ("matches('a', '(')", "expression.invalid", "pattern is invalid"),
        ("nothing.value", "expression.unknown_name", "nothing"),
        ("1 +", "expression.invalid", ""),
        ("[x for x in steps]", "expression.invalid", ""),
    ],
)
def test_static_check_reports_codes(expression: str, code: str, fragment: str) -> None:
    found = check(expression)
    assert found, expression
    assert found[0][0] == code, found
    assert fragment in found[0][1]


def test_runtime_errors_are_invalid_argument() -> None:
    with pytest.raises(AppError, match="must be"):
        evaluate("abs(parameters.name)", CONTEXT)
    with pytest.raises(AppError, match="shift"):
        evaluate("1 << 100000", CONTEXT)
    with pytest.raises(AppError):
        evaluate("u16le(parameters.raw, 3)", CONTEXT)
    # Attribute syntax is a field lookup, never Python attribute access.
    with pytest.raises(AppError, match="Unknown field __class__"):
        evaluate("parameters.name.__class__", CONTEXT)


def test_context_values_stay_dynamic_for_the_checker() -> None:
    # The checker cannot know what parameters.x is, so it must not reject a numeric use.
    assert check("abs(parameters.x) + int(variables.s, 16)") == []
    assert check("steps.a.captures.code.startsWith('E')") == []


def test_plan_validation_reports_expression_issues() -> None:
    plan = empty_plan("Plan", "plan")
    plan["regions"]["test"] = [
        {"id": "a", "type": "SetVariable", "name": "x", "valueExpression": "foo(1)"},
        {"id": "b", "type": "SetVariable", "name": "y", "valueExpression": "abs(1, 2)"},
        {"id": "c", "type": "SetVariable", "name": "z", "valueExpression": "1 << 2"},
    ]
    found = {
        (item["code"], item["path"])
        for item in validate_plan(plan)
        if item["code"].startswith("expression.")
    }
    assert ("expression.unknown_function", "/regions/test/0/valueExpression") in found
    assert ("expression.arity", "/regions/test/1/valueExpression") in found
    assert not any(path.startswith("/regions/test/2") for _, path in found)
