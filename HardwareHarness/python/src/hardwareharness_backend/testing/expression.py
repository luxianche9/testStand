from __future__ import annotations

import ast
import re
from typing import Any

from hardwareharness_backend.contracts.errors import app_error

_NOT = re.compile(r"!(?!=)")


def evaluate(expression: str, context: dict[str, Any]) -> Any:
    """Evaluate a deliberately small CEL-compatible expression subset without eval()."""
    if not isinstance(expression, str) or not expression.strip():
        raise app_error("invalid_argument", "Expression must be a non-empty string")
    source = expression.replace("&&", " and ").replace("||", " or ")
    source = _NOT.sub(" not ", source)
    source = re.sub(r"\btrue\b", "True", source, flags=re.IGNORECASE)
    source = re.sub(r"\bfalse\b", "False", source, flags=re.IGNORECASE)
    source = re.sub(r"\bnull\b", "None", source, flags=re.IGNORECASE)
    try:
        tree = ast.parse(source, mode="eval")
        return _node(tree.body, context)
    except Exception as error:
        if getattr(error, "category", None):
            raise
        raise app_error("invalid_argument", f"Invalid CEL expression: {error}") from error


def _node(node: ast.AST, context: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in {"True", "False", "None"}:
            return {"True": True, "False": False, "None": None}[node.id]
        if node.id not in context:
            raise KeyError(f"Unknown name {node.id}")
        return context[node.id]
    if isinstance(node, ast.Attribute):
        value = _node(node.value, context)
        if isinstance(value, dict) and node.attr in value:
            return value[node.attr]
        raise KeyError(f"Unknown field {node.attr}")
    if isinstance(node, ast.Subscript):
        return _node(node.value, context)[_node(node.slice, context)]
    if isinstance(node, ast.List):
        return [_node(item, context) for item in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_node(item, context) for item in node.elts)
    if isinstance(node, ast.Dict):
        if any(key is None for key in node.keys):
            raise ValueError("CEL map unpacking is not supported")
        return {
            _node(key, context): _node(value, context)  # type: ignore[arg-type]
            for key, value in zip(node.keys, node.values, strict=True)
        }
    if isinstance(node, ast.UnaryOp):
        value = _node(node.operand, context)
        if isinstance(node.op, ast.Not):
            return not value
        if isinstance(node.op, ast.USub):
            return -value
        if isinstance(node.op, ast.UAdd):
            return +value
    if isinstance(node, ast.BoolOp):
        values = [_node(item, context) for item in node.values]
        return all(values) if isinstance(node.op, ast.And) else any(values)
    if isinstance(node, ast.BinOp):
        left, right = _node(node.left, context), _node(node.right, context)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
        if isinstance(node.op, ast.Mod):
            return left % right
    if isinstance(node, ast.Compare):
        left = _node(node.left, context)
        for operator, comparator in zip(node.ops, node.comparators, strict=True):
            right = _node(comparator, context)
            if isinstance(operator, ast.Eq):
                matches = left == right
            elif isinstance(operator, ast.NotEq):
                matches = left != right
            elif isinstance(operator, ast.Lt):
                matches = left < right
            elif isinstance(operator, ast.LtE):
                matches = left <= right
            elif isinstance(operator, ast.Gt):
                matches = left > right
            elif isinstance(operator, ast.GtE):
                matches = left >= right
            elif isinstance(operator, ast.In):
                matches = left in right
            elif isinstance(operator, ast.NotIn):
                matches = left not in right
            else:
                matches = None
            if matches is None or not matches:
                return False
            left = right
        return True
    raise ValueError(f"Unsupported CEL syntax: {type(node).__name__}")
