"""Frame-local field expressions (``expr`` in ICD fields, design §6.2).

A deliberately small, side-effect free subset of the §7.3 expression language that can only
reference fields decoded earlier from the *same* frame. Expressions are checked when the ICD is
loaded (syntax, allowed operators, known names) so decoding never meets an unknown construct.

Supported: numeric/bool/string literals, field names, ``+ - * / // %``, bitwise
``& | ^ << >> ~``, comparisons (chained), ``&& || !`` (or ``and or not``), ``a if c else b``,
and the functions ``abs min max round int float bit(x, n) bits(x, lo, hi)``.
"""

from __future__ import annotations

import ast
import math
import re
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Any

from hardwareharness_backend.contracts.errors import app_error

_NOT = re.compile(r"!(?!=)")
MAX_SHIFT = 64
MAX_LENGTH = 512


def _bit(value: Any, index: Any) -> int:
    return (int(value) >> _shift(index)) & 1


def _bits(value: Any, lo: Any, hi: Any) -> int:
    low, high = _shift(lo), _shift(hi)
    if high < low:
        raise ValueError("bits(x, lo, hi) needs lo <= hi")
    return (int(value) >> low) & ((1 << (high - low + 1)) - 1)


def _shift(value: Any) -> int:
    amount = int(value)
    if not 0 <= amount <= MAX_SHIFT:
        raise ValueError(f"shift/bit index must be within 0..{MAX_SHIFT}")
    return amount


def _number(value: Any) -> int | float:
    if isinstance(value, (int, float)):
        return value
    raise TypeError(f"expected a number, got {type(value).__name__}")


def _round(value: Any, digits: Any = 0) -> float | int:
    return round(float(value), int(digits)) if digits else round(float(value))


FUNCTIONS: Mapping[str, Callable[..., Any]] = {
    "abs": abs,
    "min": min,
    "max": max,
    "round": _round,
    "int": int,
    "float": float,
    "bit": _bit,
    "bits": _bits,
}
_BINARY: Mapping[type[ast.operator], Callable[[Any, Any], Any]] = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: _number(a) * _number(b),
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
    ast.BitAnd: lambda a, b: a & b,
    ast.BitOr: lambda a, b: a | b,
    ast.BitXor: lambda a, b: a ^ b,
    ast.LShift: lambda a, b: a << _shift(b),
    ast.RShift: lambda a, b: a >> _shift(b),
}
_COMPARE: Mapping[type[ast.cmpop], Callable[[Any, Any], bool]] = {
    ast.Eq: lambda a, b: bool(a == b),
    ast.NotEq: lambda a, b: bool(a != b),
    ast.Lt: lambda a, b: bool(a < b),
    ast.LtE: lambda a, b: bool(a <= b),
    ast.Gt: lambda a, b: bool(a > b),
    ast.GtE: lambda a, b: bool(a >= b),
}


@dataclass(frozen=True)
class FieldExpression:
    source: str
    tree: ast.expr
    names: frozenset[str]

    def evaluate(self, fields: Mapping[str, Any]) -> Any:
        try:
            value = _eval(self.tree, fields)
        except Exception as error:
            raise app_error(
                "invalid_argument", f"Expression {self.source!r} failed: {error}"
            ) from error
        if isinstance(value, float) and not math.isfinite(value):
            raise app_error("invalid_argument", f"Expression {self.source!r} is not finite")
        return value


def compile_expression(source: str, names: Collection[str]) -> FieldExpression:
    """Parse and statically check ``source``; ``names`` are the fields it may reference."""
    if not source.strip() or len(source) > MAX_LENGTH:
        raise ValueError(f"expression must be 1..{MAX_LENGTH} characters")
    text = source.replace("&&", " and ").replace("||", " or ")
    text = _NOT.sub(" not ", text)
    text = re.sub(r"\btrue\b", "True", text)
    text = re.sub(r"\bfalse\b", "False", text)
    try:
        tree = ast.parse(text, mode="eval").body
    except SyntaxError as error:
        raise ValueError(f"invalid expression {source!r}: {error.msg}") from None
    used: set[str] = set()
    for node in ast.walk(tree):
        _check(node, used)
    unknown = sorted(used - set(names))
    if unknown:
        raise ValueError(
            f"expression {source!r} references unknown field(s) {', '.join(unknown)}; "
            "only fields decoded earlier in the same message are visible"
        )
    return FieldExpression(source, tree, frozenset(used))


_ALLOWED = (
    ast.Constant,
    ast.Name,
    ast.Load,
    ast.BinOp,
    ast.UnaryOp,
    ast.BoolOp,
    ast.Compare,
    ast.IfExp,
    ast.Call,
    ast.And,
    ast.Or,
    ast.Not,
    ast.USub,
    ast.UAdd,
    ast.Invert,
    *_BINARY,
    *_COMPARE,
)


def _check(node: ast.AST, used: set[str]) -> None:
    if not isinstance(node, _ALLOWED):
        raise ValueError(f"{type(node).__name__} is not allowed in field expressions")
    if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float, str)):
        raise ValueError(f"literal {node.value!r} is not allowed in field expressions")
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS:
            raise ValueError(f"only the functions {', '.join(FUNCTIONS)} may be called")
        if node.keywords:
            raise ValueError("keyword arguments are not allowed in field expressions")
    elif isinstance(node, ast.Name) and node.id not in {*FUNCTIONS, "True", "False"}:
        used.add(node.id)


def _eval(node: ast.expr, fields: Mapping[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in {"True", "False"}:
            return node.id == "True"
        return fields[node.id]
    if isinstance(node, ast.BinOp):
        return _BINARY[type(node.op)](_eval(node.left, fields), _eval(node.right, fields))
    if isinstance(node, ast.UnaryOp):
        operand = _eval(node.operand, fields)
        if isinstance(node.op, ast.Not):
            return not operand
        if isinstance(node.op, ast.USub):
            return -operand
        if isinstance(node.op, ast.Invert):
            return ~operand
        return +operand
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(_eval(value, fields) for value in node.values)
        return any(_eval(value, fields) for value in node.values)
    if isinstance(node, ast.Compare):
        left = _eval(node.left, fields)
        for op, comparator in zip(node.ops, node.comparators, strict=True):
            right = _eval(comparator, fields)
            if not _COMPARE[type(op)](left, right):
                return False
            left = right
        return True
    if isinstance(node, ast.IfExp):
        branch = node.body if _eval(node.test, fields) else node.orelse
        return _eval(branch, fields)
    assert isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    return FUNCTIONS[node.func.id](*(_eval(argument, fields) for argument in node.args))
