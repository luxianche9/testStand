from __future__ import annotations

import hashlib
import math
from functools import cmp_to_key
from typing import Any, cast

from testforge_backend.compat import (
    UNDEFINED,
    Undefined,
    clone,
    js_number,
    js_object_is,
    js_remainder,
    js_string,
    js_trim,
    js_truthy,
    json_stringify,
    utf16_compare,
)

Json = dict[str, Any]
_DANGEROUS = {"__proto__", "prototype", "constructor"}


def stable_workflow_stringify(value: Any) -> str | Undefined:
    if value is UNDEFINED:
        return cast(Undefined, UNDEFINED)
    if isinstance(value, list):
        parts = [stable_workflow_stringify(item) for item in value]
        return "[" + ",".join("" if part is UNDEFINED else str(part) for part in parts) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                json_stringify(key) + ":" + js_string(stable_workflow_stringify(value[key]))
                for key in sorted(value, key=cmp_to_key(utf16_compare))
            )
            + "}"
        )
    return json_stringify(value)


def workflow_content_hash(value: Any) -> str:
    text = stable_workflow_stringify(value)
    if not isinstance(text, str):
        raise TypeError("The data argument must be a string or a byte buffer, received undefined")
    encoded = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def safe_path(path: str) -> list[str]:
    parts = [js_trim(part) for part in path.split(".") if js_trim(part)]
    if not parts:
        raise ValueError("Variable path is required")
    if any(part in _DANGEROUS for part in parts):
        raise ValueError(f"Unsafe workflow variable path: {path}")
    return parts


def get_workflow_path(root: Any, path: str) -> Any:
    if not js_trim(path):
        return root
    current = root
    for segment in safe_path(path):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        elif isinstance(current, list) and segment == "length":
            current = len(current)
        elif (
            isinstance(current, list)
            and segment.isascii()
            and segment.isdigit()
            and str(int(segment)) == segment
            and int(segment) < len(current)
        ):
            current = current[int(segment)]
        else:
            raise ValueError(f"Unknown workflow variable: {path}")
    return current


def set_workflow_path(root: Json, path: str, value: Any) -> None:
    parts = safe_path(path)
    if len(parts) != 1:
        raise ValueError("Workflow writes are limited to declared top-level variables")
    if parts[0] not in root:
        raise ValueError(f"Unknown workflow variable: {parts[0]}")
    root[parts[0]] = value


def resolve_workflow_value(template: Json, context: Json) -> Any:
    kind = template["kind"]
    if kind == "literal":
        return clone(template.get("value", UNDEFINED))
    if kind == "variable":
        return clone(get_workflow_path(context, template["path"]))
    if kind == "array":
        return [resolve_workflow_value(item, context) for item in template["items"]]
    if kind == "object":
        return {
            key: resolve_workflow_value(value, context)
            for key, value in template["entries"].items()
        }
    return UNDEFINED


def _number(value: Any, operator: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"{operator} requires finite numeric operands")
    return float(value)


def evaluate_workflow_expression(expression: Json, context: Json) -> Any:
    kind = expression["kind"]
    if kind == "literal":
        return expression.get("value", UNDEFINED)
    if kind == "variable":
        return get_workflow_path(context, expression["path"])
    operator = expression["operator"]
    if kind == "unary":
        operand = evaluate_workflow_expression(expression["operand"], context)
        return not js_truthy(operand) if operator == "not" else -_number(operand, "negate")
    if kind == "logical":
        if not expression["operands"]:
            raise ValueError(f"{operator} requires at least one operand")
        values = (
            js_truthy(evaluate_workflow_expression(item, context))
            for item in expression["operands"]
        )
        return all(values) if operator == "and" else any(values)
    left = evaluate_workflow_expression(expression["left"], context)
    right = evaluate_workflow_expression(expression["right"], context)
    if operator in {"eq", "neq"}:
        equal = js_object_is(left, right)
        return equal if operator == "eq" else not equal
    if operator in {"gt", "gte", "lt", "lte"}:
        if type(left) in (int, float) and type(right) in (int, float):
            if math.isnan(left) or math.isnan(right):
                return False
            compare = (left > right) - (left < right)
        elif isinstance(left, str) and isinstance(right, str):
            compare = utf16_compare(left, right)
        else:
            raise ValueError("Relational comparison requires two numbers or two strings")
        return {"gt": compare > 0, "gte": compare >= 0, "lt": compare < 0, "lte": compare <= 0}[
            operator
        ]
    if operator in {"divide", "modulo"}:
        divisor = _number(right, operator)
        if divisor == 0:
            raise ValueError("Division by zero" if operator == "divide" else "Modulo by zero")
        dividend = _number(left, operator)
        return dividend / divisor if operator == "divide" else js_remainder(dividend, divisor)
    a, b = _number(left, operator), _number(right, operator)
    return {"add": lambda: a + b, "subtract": lambda: a - b, "multiply": lambda: a * b}[operator]()


def workflow_expression_boolean(expression: Json, context: Json) -> bool:
    return js_truthy(evaluate_workflow_expression(expression, context))


def read_json_pointer(value: Any, pointer: str) -> Any:
    if pointer in {"", "/"}:
        return value
    if not pointer.startswith("/"):
        raise ValueError(f"JSON Pointer must start with '/': {pointer}")
    current = value
    for raw in pointer[1:].split("/"):
        segment = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            index = js_number(segment)
            if (
                not math.isfinite(index)
                or not float(index).is_integer()
                or index < 0
                or index >= len(current)
            ):
                raise ValueError(f"JSON Pointer not found: {pointer}")
            current = current[int(index)]
        elif isinstance(current, dict) and segment in current and segment not in _DANGEROUS:
            current = current[segment]
        else:
            raise ValueError(f"JSON Pointer not found: {pointer}")
    return current


def collect_steps(steps: list[Json]) -> list[Json]:
    output: list[Json] = []
    for step in steps:
        output.append(step)
        if step["type"] == "if":
            output.extend(collect_steps(step["then"]))
            output.extend(collect_steps(step["else"]))
        elif step["type"] == "loop":
            output.extend(collect_steps(step["body"]))
        elif step["type"] == "parallel":
            for branch in step["branches"]:
                output.extend(collect_steps(branch["steps"]))
    return output


def collect_task_steps(task: Json) -> list[Json]:
    return [
        *collect_steps(task["setup"]),
        *collect_steps(task["steps"]),
        *collect_steps(task["cleanup"]),
    ]


def create_workflow_context(task: Json, inputs: Json) -> Json:
    return {
        definition["name"]: clone(
            inputs.get(definition["name"], definition.get("defaultValue", UNDEFINED))
        )
        for definition in [*task["inputs"], *task["variables"]]
    }


def matches_workflow_type(value: Any, expected: str) -> bool:
    if expected == "unknown":
        return True
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    return runtime_type(value) == expected


def runtime_type(value: Any) -> str:
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if type(value) is bool:
        return "boolean"
    if type(value) in (int, float):
        return "number"
    if isinstance(value, str):
        return "string"
    return "unknown"


def _literal_type(value: Any) -> str:
    return "unknown" if value is None or value is UNDEFINED else runtime_type(value)


def validate_test_task(task: Json) -> Json:
    issues: list[Json] = []
    readable: dict[str, Json] = {}
    writable = {definition["name"]: definition for definition in task["variables"]}

    def add(code: str, message: str, step_id: str | None = None) -> None:
        issues.append(
            {
                "severity": "error",
                "code": code,
                "message": message,
                **({"nodeId": step_id} if step_id else {}),
            }
        )

    def require_variable(name: str, step: Json, expected: str | None = None) -> None:
        definition = writable.get(name)
        if definition is None:
            add(
                "undeclared_variable",
                f"Writable variable {name} must be declared in task.variables",
                step["stepId"],
            )
        elif expected and definition["type"] != expected:
            add("variable_type", f"Variable {name} must be {expected}", step["stepId"])

    def require_assignable(name: str, actual: str, step: Json) -> None:
        definition = writable.get(name)
        if definition and actual != "unknown" and definition["type"] not in {"unknown", actual}:
            add(
                "variable_type",
                f"Variable {name} is {definition['type']}, but the assigned value is {actual}",
                step["stepId"],
            )

    def validate_read(path: str, step: Json) -> None:
        try:
            parts = safe_path(path)
        except ValueError as error:
            add("unsafe_variable_path", str(error), step["stepId"])
            return
        if parts[0] not in readable:
            add(
                "undeclared_variable",
                f"Variable {parts[0]} must be declared before it can be read",
                step["stepId"],
            )

    def read_type(path: str) -> str:
        try:
            parts = safe_path(path)
        except ValueError:
            return "unknown"  # validate_read records the error; type inference must not throw.
        return (
            str(readable.get(parts[0], {}).get("type", "unknown")) if len(parts) == 1 else "unknown"
        )

    def value_type(value: Json) -> str:
        if value["kind"] == "literal":
            return _literal_type(value.get("value", UNDEFINED))
        if value["kind"] == "variable":
            return read_type(value["path"])
        return str(value["kind"])

    def validate_value(value: Json, step: Json) -> None:
        if value["kind"] == "variable":
            validate_read(value["path"], step)
        elif value["kind"] == "array":
            for item in value["items"]:
                validate_value(item, step)
        elif value["kind"] == "object":
            for item in value["entries"].values():
                validate_value(item, step)

    def is_type(actual: str, expected: str) -> bool:
        return actual in {"unknown", expected}

    def validate_expression(expression: Json, step: Json) -> str:
        kind = expression["kind"]
        if kind == "literal":
            return _literal_type(expression.get("value", UNDEFINED))
        if kind == "variable":
            validate_read(expression["path"], step)
            return read_type(expression["path"])
        operator = expression["operator"]
        if kind == "unary":
            operand = validate_expression(expression["operand"], step)
            if operator == "negate" and not is_type(operand, "number"):
                add("operator_type", "negate requires a number", step["stepId"])
            return "boolean" if operator == "not" else "number"
        if kind == "logical":
            for operand in expression["operands"]:
                if not is_type(validate_expression(operand, step), "boolean"):
                    add("operator_type", f"{operator} requires boolean operands", step["stepId"])
            return "boolean"
        left, right = (
            validate_expression(expression["left"], step),
            validate_expression(expression["right"], step),
        )
        if operator in {"add", "subtract", "multiply", "divide", "modulo"}:
            if not is_type(left, "number") or not is_type(right, "number"):
                add("operator_type", f"{operator} requires number operands", step["stepId"])
            return "number"
        if (
            operator in {"gt", "gte", "lt", "lte"}
            and left != "unknown"
            and right != "unknown"
            and (left != right or left not in {"number", "string"})
        ):
            add("operator_type", f"{operator} requires two numbers or two strings", step["stepId"])
        return "boolean"

    if task["formatVersion"] != 2:
        add("unsupported_format", f"Unsupported task formatVersion: {task['formatVersion']}")
    for definition in [*task["inputs"], *task["variables"]]:
        if definition["name"] in readable:
            add("duplicate_variable", f"Duplicate variable: {definition['name']}")
        readable[definition["name"]] = definition
    step_ids: set[str] = set()
    for step in collect_task_steps(task):
        sid = step["stepId"]
        if sid in step_ids:
            add("duplicate_step", f"Duplicate stepId: {sid}", sid)
        step_ids.add(sid)
        if not step["enabled"]:
            continue
        kind = step["type"]
        if kind == "set_variable":
            require_variable(step["variable"], step)
            validate_value(step["value"], step)
            require_assignable(step["variable"], value_type(step["value"]), step)
        elif kind == "tool":
            if not js_trim(step["hardwareId"]):
                add("hardware_id_required", "Tool step requires hardwareId", sid)
            for value in step["arguments"].values():
                validate_value(value, step)
            for binding in step["outputBindings"]:
                require_variable(binding["variable"], step)
        elif kind == "delay":
            validate_value(step["durationMs"], step)
            if not is_type(value_type(step["durationMs"]), "number"):
                add("duration_type", "Delay duration must resolve to a number", sid)
        elif kind in {"assert", "if"}:
            expression = step["expression" if kind == "assert" else "condition"]
            if not is_type(validate_expression(expression, step), "boolean"):
                add(
                    "expression_type",
                    "Assert expression must resolve to boolean"
                    if kind == "assert"
                    else "If condition must resolve to boolean",
                    sid,
                )
        elif kind == "loop":
            require_variable(step["indexVariable"], step, "number")
            if step["mode"] == "count":
                if not step.get("count"):
                    add("loop_count_required", "Count loop requires a count value", sid)
                else:
                    validate_value(step["count"], step)
                    if not is_type(value_type(step["count"]), "number"):
                        add("loop_count_type", "Loop count must resolve to a number", sid)
            elif not step.get("condition"):
                add("loop_condition_required", "While loop requires a condition", sid)
            elif not is_type(validate_expression(step["condition"], step), "boolean"):
                add("expression_type", "While condition must resolve to boolean", sid)
        elif kind == "parallel":
            for branch in step["branches"]:
                for nested in collect_steps(branch["steps"]):
                    if (
                        nested["type"] == "set_variable"
                        or nested["type"] == "tool"
                        and nested["outputBindings"]
                        or nested["type"] == "operator"
                        and nested.get("resultVariable")
                    ):
                        add(
                            "parallel_shared_write",
                            f"Parallel branch {branch['name']} cannot write shared variables",
                            nested["stepId"],
                        )
        elif kind == "operator" and step.get("resultVariable"):
            require_variable(step["resultVariable"], step)
            for option in step["options"]:
                require_assignable(
                    step["resultVariable"], _literal_type(option.get("value", UNDEFINED)), step
                )
    return {"valid": not any(issue["severity"] == "error" for issue in issues), "issues": issues}
