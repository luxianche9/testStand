from __future__ import annotations

from typing import Any

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.protocol.expr import FUNCTIONS, compile_expression


def evaluate(source: str, **fields: Any) -> Any:
    return compile_expression(source, fields).evaluate(fields)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("a * 2 + b", 7),
        ("a / 2", 1.0),
        ("7 // 2 + 7 % 2", 4),
        ("(a << 4) | b", 0x23),
        ("0xF0 & 0x3C ^ 1", 0x31),
        ("~a", -3),
        ("-a + +b", 1),
        ("a > 1 && b < 4", True),
        ("a > 5 || !(b == 3)", False),
        ("true && !false", True),
        ("1 < a <= 2 != 3", True),
        ("1 < a > 5", False),
        ("'hi' if a == 2 else 'lo'", "hi"),
        ("bit(5, 2) + bits(0xB4, 2, 5)", 1 + 0xD),
        ("abs(-3) + min(a, b) + max(1, 2)", 7),
        ("round(2.345, 2)", 2.35),
        ("round(2.5)", 2),
        ("int(3.9) + float(1)", 4.0),
        ("a != 2", False),
    ],
)
def test_evaluates(source: str, expected: Any) -> None:
    assert evaluate(source, a=2, b=3) == expected


def test_reports_referenced_names() -> None:
    expression = compile_expression("bit(raw, 0) && ok", {"raw", "ok", "unused"})
    assert expression.names == frozenset({"raw", "ok"})
    assert set(FUNCTIONS) == {"abs", "min", "max", "round", "int", "float", "bit", "bits"}


@pytest.mark.parametrize(
    "source",
    ["a << 65", "bit(a, -1)", "bits(a, 3, 1)", "'x' * 1000", "a / 0", "float('inf')", "a + 'x'"],
)
def test_runtime_errors_are_invalid_argument(source: str) -> None:
    with pytest.raises(AppError) as caught:
        evaluate(source, a=2)
    assert caught.value.category == "invalid_argument"
    assert source in str(caught.value)


@pytest.mark.parametrize(
    ("source", "needle"),
    [
        ("x", "unknown field"),
        ("a.real", "Attribute"),
        ("[a]", "List"),
        ("a[0]", "Subscript"),
        ("lambda: 1", "Lambda"),
        ("(a := 1)", "NamedExpr"),
        ("__import__('os')", "only the functions"),
        ("(1)(2)", "only the functions"),
        ("b'x'", "literal"),
        ("a ** 2", "Pow"),
        ("a @ a", "MatMult"),
        ("a in a", "In"),
        ("x" * 513, "1..512"),
    ],
)
def test_compile_rejections(source: str, needle: str) -> None:
    with pytest.raises(ValueError, match=needle):
        compile_expression(source, {"a"})
