"""A small, side-effect free CEL subset over Python's AST (design §7.3).

``evaluate`` runs an expression against ``{parameters, variables, steps, item, index}``;
``check`` type-checks it without a context so plan validation can report unknown
functions, wrong arity and type errors before the plan runs. Both share one
function table and one operator table, so what compiles is what runs.
"""

from __future__ import annotations

import ast
import math
import re
import struct
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from teststand_backend.contracts.errors import app_error

CONTEXT_NAMES = ("parameters", "variables", "steps", "item", "index")
MAX_SHIFT = 4096

Types = frozenset[str]
INT, FLOAT, BOOL, STRING, BYTES, LIST, MAP, NULL = (
    "int",
    "float",
    "bool",
    "string",
    "bytes",
    "list",
    "map",
    "null",
)
DYN: Types = frozenset({INT, FLOAT, BOOL, STRING, BYTES, LIST, MAP, NULL})
NUMBER: Types = frozenset({INT, FLOAT})
_ONE = {name: frozenset({name}) for name in DYN}
_T_INT, _T_FLOAT, _T_BOOL, _T_STRING = _ONE[INT], _ONE[FLOAT], _ONE[BOOL], _ONE[STRING]
_T_BYTES, _T_LIST = _ONE[BYTES], _ONE[LIST]
_BYTES_LIKE: Types = frozenset({BYTES, STRING})  # hex strings are accepted where bytes are

_NOT = re.compile(r"!(?!=)")
_STRING_LITERAL = re.compile(r"(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')", re.DOTALL)
PathTypes = Callable[[tuple[str, ...]], Types | None]


# -- public API ----------------------------------------------------------------------------


def evaluate(expression: str, context: dict[str, Any]) -> Any:
    """Evaluate a deliberately small CEL-compatible expression subset without eval()."""
    tree = _parse(expression)
    try:
        return _plain(_node(tree.body, context))
    except Exception as error:
        if getattr(error, "category", None):
            raise
        raise app_error("invalid_argument", f"Invalid CEL expression: {error}") from error


def check(expression: str, path_types: PathTypes | None = None) -> list[tuple[str, str]]:
    """Static issues ``[(code, message)]`` of an expression; empty when it type-checks.

    ``path_types`` may give the type of a context path such as ``("parameters", "limit")``;
    unknown paths are dynamic and only literal-level mistakes are reported for them.
    """
    try:
        tree = _parse(expression)
    except Exception as error:
        return [("expression.invalid", str(error))]
    checker = _Checker(path_types)
    checker.visit(tree.body)
    return checker.issues


def references_context(expression: str) -> bool:
    """Whether the expression reads any context name (otherwise it is a constant)."""
    try:
        tree = _parse(expression)
    except Exception:
        return True
    return any(isinstance(node, ast.Name) and node.id in CONTEXT_NAMES for node in ast.walk(tree))


def function_names() -> list[str]:
    return sorted(FUNCTIONS)


# -- parsing -------------------------------------------------------------------------------


def _parse(expression: str) -> ast.Expression:
    if not isinstance(expression, str) or not expression.strip():
        raise app_error("invalid_argument", "Expression must be a non-empty string")
    try:
        return ast.parse(_translate(expression), mode="eval")
    except SyntaxError as error:
        raise app_error("invalid_argument", f"Invalid CEL expression: {error.msg}") from error


def _translate(expression: str) -> str:
    """CEL spellings to Python ones, leaving string literals untouched."""
    parts = _STRING_LITERAL.split(expression)
    for index in range(0, len(parts), 2):
        source = parts[index].replace("&&", " and ").replace("||", " or ")
        source = _NOT.sub(" not ", source)
        source = re.sub(r"\btrue\b", "True", source, flags=re.IGNORECASE)
        source = re.sub(r"\bfalse\b", "False", source, flags=re.IGNORECASE)
        parts[index] = re.sub(r"\bnull\b", "None", source, flags=re.IGNORECASE)
    return "".join(parts)


# -- functions -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Function:
    impl: Callable[..., Any]
    params: tuple[Types, ...]
    returns: Types | Callable[[list[Types]], Types]
    optional: int = 0
    variadic: Types | None = None
    method: bool = False  # may also be written ``receiver.name(args)``

    @property
    def min_args(self) -> int:
        return len(self.params) - self.optional

    @property
    def max_args(self) -> float:
        return math.inf if self.variadic is not None else len(self.params)

    def param(self, index: int) -> Types:
        if index < len(self.params):
            return self.params[index]
        return self.variadic or DYN

    def result(self, args: list[Types]) -> Types:
        return self.returns(args) if callable(self.returns) else self.returns


def _numbers(values: list[Any], name: str) -> list[Any]:
    items = values[0] if len(values) == 1 and isinstance(values[0], (list, tuple)) else values
    if not items:
        raise ValueError(f"{name}() of an empty list")
    for item in items:
        if _typeof(item) not in NUMBER:
            raise TypeError(f"{name}() needs numbers, got {_typeof(item)}")
    return list(items)


def _round(value: Any, digits: int | None = None) -> Any:
    return round(value) if digits is None else round(float(value), digits)


def _sqrt(value: Any) -> float:
    if value < 0:
        raise ValueError("sqrt() of a negative number")
    return math.sqrt(value)


def _int(value: Any, base: int | None = None) -> int:
    if base is not None:
        if not isinstance(value, str):
            raise TypeError("int(s, base) needs a string")
        return int(value.strip(), base)
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("int() of a non-finite number")
    return int(value.strip()) if isinstance(value, str) else int(value)


def _str(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


def _hex(value: Any) -> str:
    return value.hex() if isinstance(value, bytes) else hex(value)


def _sum(values: list[Any]) -> Any:
    return sum(_numbers(values, "sum")) if values else 0


def _bit(value: int, n: int) -> int:
    if n < 0 or n > MAX_SHIFT:
        raise ValueError(f"bit index must be 0..{MAX_SHIFT}")
    return (value >> n) & 1


def _bits(value: int, lo: int, hi: int) -> int:
    if lo < 0 or hi < lo or hi > MAX_SHIFT:
        raise ValueError(f"bits(x, lo, hi) needs 0 <= lo <= hi <= {MAX_SHIFT}")
    return (value >> lo) & ((1 << (hi - lo + 1)) - 1)


def _bytes_hex(text: str) -> bytes:
    return bytes.fromhex(text.replace(" ", ""))


def _as_bytes(value: Any) -> bytes:
    return value if isinstance(value, bytes) else _bytes_hex(str(value))


def _unpacker(fmt: str) -> Callable[[Any, int], Any]:
    size = struct.calcsize(fmt)

    def unpack(data: Any, offset: int) -> Any:
        raw = _as_bytes(data)
        if offset < 0 or offset + size > len(raw):
            raise IndexError(f"offset {offset} + {size} bytes is outside {len(raw)} bytes")
        return struct.unpack_from(fmt, raw, offset)[0]

    return unpack


def _contains(container: Any, needle: Any) -> bool:
    if isinstance(container, str):
        if not isinstance(needle, str):
            raise TypeError("contains() on a string needs a string")
        return needle in container
    if isinstance(container, bytes):
        return _as_bytes(needle) in container
    return needle in container


def _split(text: str, separator: str | None = None) -> list[str]:
    if separator == "":
        raise ValueError("split() separator must not be empty")
    return text.split(separator)


def _same_as_first(args: list[Types]) -> Types:
    return (args[0] & NUMBER) or NUMBER if args else NUMBER


def _round_type(args: list[Types]) -> Types:
    return _T_INT if len(args) == 1 else _T_FLOAT


_ANY_NUMBERS = NUMBER | _T_LIST
FUNCTIONS: dict[str, Function] = {
    # numeric
    "abs": Function(abs, (NUMBER,), _same_as_first),
    "min": Function(lambda *v: min(_numbers(list(v), "min")), (_ANY_NUMBERS,), NUMBER, 0, NUMBER),
    "max": Function(lambda *v: max(_numbers(list(v), "max")), (_ANY_NUMBERS,), NUMBER, 0, NUMBER),
    "round": Function(_round, (NUMBER, _T_INT), _round_type, optional=1),
    "floor": Function(math.floor, (NUMBER,), _T_INT),
    "ceil": Function(math.ceil, (NUMBER,), _T_INT),
    "sqrt": Function(_sqrt, (NUMBER,), _T_FLOAT),
    # conversion
    "int": Function(_int, (NUMBER | _T_STRING | _T_BOOL, _T_INT), _T_INT, optional=1),
    "float": Function(lambda v: float(v), (NUMBER | _T_STRING,), _T_FLOAT),
    "str": Function(_str, (DYN,), _T_STRING),
    "hex": Function(_hex, (_T_INT | _T_BYTES,), _T_STRING),
    # collections
    "len": Function(len, (frozenset({STRING, BYTES, LIST, MAP}),), _T_INT),
    "sum": Function(_sum, (_T_LIST,), NUMBER),
    "all": Function(lambda v: all(v), (_T_LIST,), _T_BOOL),
    "any": Function(lambda v: any(v), (_T_LIST,), _T_BOOL),
    "sorted": Function(lambda v: sorted(v), (_T_LIST,), _T_LIST),
    # bits
    "bit": Function(_bit, (_T_INT, _T_INT), _T_INT),
    "bits": Function(_bits, (_T_INT, _T_INT, _T_INT), _T_INT),
    # bytes (complex decoding belongs in the ICD layer, design §6)
    "bytes_hex": Function(_bytes_hex, (_T_STRING,), _T_BYTES),
    **{
        name: Function(_unpacker(fmt), (_BYTES_LIKE, _T_INT), _T_FLOAT if "f" in fmt else _T_INT)
        for name, fmt in {
            "u8": "<B",
            "i8": "<b",
            "u16le": "<H",
            "u16be": ">H",
            "i16le": "<h",
            "i16be": ">h",
            "u32le": "<I",
            "u32be": ">I",
            "i32le": "<i",
            "i32be": ">i",
            "f32le": "<f",
            "f32be": ">f",
        }.items()
    },
    # strings (CEL receiver style ``s.startsWith("x")`` or ``startsWith(s, "x")``)
    "startsWith": Function(
        lambda s, p: s.startswith(p), (_T_STRING, _T_STRING), _T_BOOL, 0, None, True
    ),
    "endsWith": Function(
        lambda s, p: s.endswith(p), (_T_STRING, _T_STRING), _T_BOOL, 0, None, True
    ),
    "contains": Function(
        _contains, (frozenset({STRING, BYTES, LIST, MAP}), DYN), _T_BOOL, 0, None, True
    ),
    "matches": Function(
        lambda s, p: re.search(p, s) is not None, (_T_STRING, _T_STRING), _T_BOOL, 0, None, True
    ),
    "split": Function(_split, (_T_STRING, _T_STRING), _T_LIST, 1, None, True),
    "trim": Function(lambda s: s.strip(), (_T_STRING,), _T_STRING, 0, None, True),
}


# -- operators -----------------------------------------------------------------------------

_NUMERIC_RULES: list[tuple[str, str, str]] = [
    (INT, INT, INT),
    (INT, FLOAT, FLOAT),
    (FLOAT, INT, FLOAT),
    (FLOAT, FLOAT, FLOAT),
]
_BITWISE_RULES: list[tuple[str, str, str]] = [(INT, INT, INT)]
_BINARY: dict[type[ast.operator], tuple[str, list[tuple[str, str, str]]]] = {
    ast.Add: (
        "+",
        _NUMERIC_RULES + [(STRING, STRING, STRING), (LIST, LIST, LIST), (BYTES, BYTES, BYTES)],
    ),
    ast.Sub: ("-", _NUMERIC_RULES),
    ast.Mult: ("*", _NUMERIC_RULES),
    ast.Div: ("/", [(a, b, FLOAT) for a, b, _ in _NUMERIC_RULES]),
    ast.Mod: ("%", _NUMERIC_RULES),
    ast.BitAnd: ("&", _BITWISE_RULES),
    ast.BitOr: ("|", _BITWISE_RULES),
    ast.BitXor: ("^", _BITWISE_RULES),
    ast.LShift: ("<<", _BITWISE_RULES),
    ast.RShift: (">>", _BITWISE_RULES),
}
_ORDERED = frozenset({INT, FLOAT, STRING, BYTES})


def _binary_result(op: ast.operator, left: Types, right: Types) -> Types | None:
    """Result types of ``left op right``, ``None`` if no combination is valid."""
    _, rules = _BINARY[type(op)]
    result = {out for a, b, out in rules if a in left and b in right}
    return frozenset(result) if result else None


def _apply_binary(op: ast.operator, left: Any, right: Any) -> Any:
    symbol, _ = _BINARY[type(op)]
    if _binary_result(op, _ONE.get(_typeof(left), DYN), _ONE.get(_typeof(right), DYN)) is None:
        raise TypeError(
            f"operator {symbol} cannot be applied to {_typeof(left)} and {_typeof(right)}"
        )
    if isinstance(op, (ast.LShift, ast.RShift)) and not 0 <= right <= MAX_SHIFT:
        raise ValueError(f"shift count must be 0..{MAX_SHIFT}")
    if isinstance(op, ast.Add):
        return left + right
    if isinstance(op, ast.Sub):
        return left - right
    if isinstance(op, ast.Mult):
        return left * right
    if isinstance(op, ast.Div):
        return left / right
    if isinstance(op, ast.Mod):
        return left % right
    if isinstance(op, ast.BitAnd):
        return left & right
    if isinstance(op, ast.BitOr):
        return left | right
    if isinstance(op, ast.BitXor):
        return left ^ right
    if isinstance(op, ast.LShift):
        return left << right
    return left >> right


# -- evaluation ----------------------------------------------------------------------------


def _typeof(value: Any) -> str:
    if isinstance(value, bool):
        return BOOL
    if isinstance(value, int):
        return INT
    if isinstance(value, float):
        return FLOAT
    if isinstance(value, str):
        return STRING
    if isinstance(value, bytes):
        return BYTES
    if isinstance(value, (list, tuple)):
        return LIST
    if isinstance(value, dict):
        return MAP
    if value is None:
        return NULL
    return type(value).__name__


def _describe(types: Types) -> str:
    return " or ".join(sorted(types))


def _plain(value: Any) -> Any:
    """Results leave the evaluator JSON-friendly: bytes become hex strings."""
    return value.hex() if isinstance(value, bytes) else value


def _call(name: str, args: list[Any]) -> Any:
    function = FUNCTIONS[name]
    if not function.min_args <= len(args) <= function.max_args:
        raise TypeError(_arity_message(name, function, len(args)))
    for index, value in enumerate(args):
        allowed = function.param(index)
        if _typeof(value) not in allowed:
            raise TypeError(
                f"{name}() argument {index + 1} must be {_describe(allowed)}, got {_typeof(value)}"
            )
    return function.impl(*args)


def _arity_message(name: str, function: Function, count: int) -> str:
    low, high = function.min_args, function.max_args
    expected = (
        f"at least {low}"
        if high == math.inf
        else str(low)
        if low == high
        else f"{low} to {int(high)}"
    )
    return f"{name}() takes {expected} argument{'s' if expected != '1' else ''}, got {count}"


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
    if isinstance(node, ast.Call):
        name, receiver = _callee(node)
        if name is None:
            raise ValueError("Only built-in functions can be called")
        if name not in FUNCTIONS or (receiver is not None and not FUNCTIONS[name].method):
            raise ValueError(f"Unknown function {name}")
        if node.keywords or any(isinstance(arg, ast.Starred) for arg in node.args):
            raise ValueError("Keyword and starred arguments are not supported")
        args = [_node(arg, context) for arg in node.args]
        if receiver is not None:
            args.insert(0, _node(receiver, context))
        return _call(name, args)
    if isinstance(node, ast.UnaryOp):
        value = _node(node.operand, context)
        if isinstance(node.op, ast.Not):
            return not value
        if isinstance(node.op, ast.Invert):
            if _typeof(value) != INT:
                raise TypeError(f"operator ~ cannot be applied to {_typeof(value)}")
            return ~value
        if _typeof(value) not in NUMBER:
            raise TypeError(f"unary minus/plus cannot be applied to {_typeof(value)}")
        if isinstance(node.op, ast.USub):
            return -value
        if isinstance(node.op, ast.UAdd):
            return +value
    if isinstance(node, ast.BoolOp):
        values = [_node(item, context) for item in node.values]
        return all(values) if isinstance(node.op, ast.And) else any(values)
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        return _apply_binary(node.op, _node(node.left, context), _node(node.right, context))
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


def _callee(node: ast.Call) -> tuple[str | None, ast.expr | None]:
    """``(function name, receiver)`` of a call; receiver is set for ``x.name(...)``."""
    if isinstance(node.func, ast.Name):
        return node.func.id, None
    if isinstance(node.func, ast.Attribute):
        return node.func.attr, node.func.value
    return None, None


# -- static checking -----------------------------------------------------------------------


class _Checker:
    def __init__(self, path_types: PathTypes | None) -> None:
        self.path_types = path_types
        self.issues: list[tuple[str, str]] = []

    def fail(self, code: str, message: str) -> Types:
        self.issues.append((code, message))
        return DYN

    def visit(self, node: ast.AST) -> Types:
        if isinstance(node, ast.Constant):
            kind = _typeof(node.value)
            return _ONE.get(kind) or self.fail(
                "expression.invalid", f"Unsupported literal of type {kind}"
            )
        if isinstance(node, ast.Name):
            if node.id in {"True", "False"}:
                return _T_BOOL
            if node.id == "None":
                return _ONE[NULL]
            if node.id not in CONTEXT_NAMES:
                return self.fail(
                    "expression.unknown_name",
                    f"Unknown name {node.id}; available: {', '.join(CONTEXT_NAMES)}",
                )
            return self._path_type(node)
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            return self._access(node)
        if isinstance(node, (ast.List, ast.Tuple)):
            for item in node.elts:
                self.visit(item)
            return _T_LIST
        if isinstance(node, ast.Dict):
            if any(key is None for key in node.keys):
                return self.fail("expression.invalid", "CEL map unpacking is not supported")
            for key, value in zip(node.keys, node.values, strict=True):
                self.visit(key)  # type: ignore[arg-type]
                self.visit(value)
            return _ONE[MAP]
        if isinstance(node, ast.Call):
            return self._call(node)
        if isinstance(node, ast.UnaryOp):
            operand = self.visit(node.operand)
            if isinstance(node.op, ast.Not):
                return _T_BOOL
            if isinstance(node.op, ast.Invert):
                if INT not in operand:
                    return self.fail(
                        "expression.type",
                        f"operator ~ cannot be applied to {_describe(operand)}",
                    )
                return _T_INT
            if not operand & NUMBER:
                return self.fail(
                    "expression.type",
                    f"unary minus/plus cannot be applied to {_describe(operand)}",
                )
            return operand & NUMBER
        if isinstance(node, ast.BoolOp):
            for item in node.values:
                self.visit(item)
            return _T_BOOL
        if isinstance(node, ast.BinOp):
            left, right = self.visit(node.left), self.visit(node.right)
            if type(node.op) not in _BINARY:
                return self.fail(
                    "expression.invalid", f"Unsupported CEL operator: {type(node.op).__name__}"
                )
            result = _binary_result(node.op, left, right)
            if result is None:
                return self.fail(
                    "expression.type",
                    f"operator {_BINARY[type(node.op)][0]} cannot be applied to "
                    f"{_describe(left)} and {_describe(right)}",
                )
            return result
        if isinstance(node, ast.Compare):
            return self._compare(node)
        return self.fail("expression.invalid", f"Unsupported CEL syntax: {type(node).__name__}")

    def _path(self, node: ast.AST) -> tuple[str, ...] | None:
        if isinstance(node, ast.Name):
            return (node.id,)
        if isinstance(node, ast.Attribute):
            parent = self._path(node.value)
            return None if parent is None else (*parent, node.attr)
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, (str, int))
            and not isinstance(node.slice.value, bool)
        ):
            parent = self._path(node.value)
            return None if parent is None else (*parent, str(node.slice.value))
        return None

    def _path_type(self, node: ast.AST) -> Types:
        path = self._path(node)
        if path is None or self.path_types is None:
            return DYN
        return self.path_types(path) or DYN

    def _access(self, node: ast.Attribute | ast.Subscript) -> Types:
        container = self.visit(node.value)
        if isinstance(node, ast.Attribute):
            if MAP not in container:
                return self.fail(
                    "expression.type",
                    f"Field .{node.attr} cannot be read from {_describe(container)}",
                )
        else:
            index = self.visit(node.slice)
            if not container & frozenset({LIST, MAP, STRING, BYTES}):
                return self.fail("expression.type", f"{_describe(container)} cannot be indexed")
            if MAP not in container and INT not in index:
                return self.fail("expression.type", f"{_describe(container)} index must be int")
        return self._path_type(node)

    def _call(self, node: ast.Call) -> Types:
        name, receiver = _callee(node)
        if name is None:
            return self.fail("expression.unknown_function", "Only built-in functions can be called")
        function = FUNCTIONS.get(name)
        if function is None or (receiver is not None and not function.method):
            known = ", ".join(sorted(FUNCTIONS))
            return self.fail(
                "expression.unknown_function", f"Unknown function {name}; available: {known}"
            )
        if node.keywords or any(isinstance(arg, ast.Starred) for arg in node.args):
            return self.fail(
                "expression.invalid", "Keyword and starred arguments are not supported"
            )
        nodes = ([receiver] if receiver is not None else []) + list(node.args)
        args = [self.visit(arg) for arg in nodes]
        if not function.min_args <= len(args) <= function.max_args:
            return self.fail("expression.arity", _arity_message(name, function, len(args)))
        ok = True
        for index, actual in enumerate(args):
            allowed = function.param(index)
            if not actual & allowed:
                ok = False
                self.fail(
                    "expression.type",
                    f"{name}() argument {index + 1} must be {_describe(allowed)}, "
                    f"got {_describe(actual)}",
                )
        if name == "matches" and len(nodes) == 2:
            pattern = nodes[1]
            if isinstance(pattern, ast.Constant) and isinstance(pattern.value, str):
                try:
                    re.compile(pattern.value)
                except re.error as error:
                    ok = False
                    self.fail("expression.invalid", f"matches() pattern is invalid: {error}")
        return function.result(args) if ok else DYN

    def _compare(self, node: ast.Compare) -> Types:
        left = self.visit(node.left)
        for operator, comparator in zip(node.ops, node.comparators, strict=True):
            right = self.visit(comparator)
            if isinstance(operator, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)):
                comparable = (left & NUMBER and right & NUMBER) or (left & right & _ORDERED)
                if not comparable:
                    self.fail(
                        "expression.type",
                        f"{_describe(left)} and {_describe(right)} cannot be ordered",
                    )
            elif isinstance(operator, (ast.In, ast.NotIn)):
                if not right & frozenset({LIST, MAP, STRING, BYTES}):
                    self.fail(
                        "expression.type",
                        f"'in' needs a list, map or string, got {_describe(right)}",
                    )
            elif not isinstance(operator, (ast.Eq, ast.NotEq)):
                self.fail("expression.invalid", "Unsupported comparison operator")
            left = right
        return _T_BOOL
