from __future__ import annotations

import re
from typing import Any

from hardwareharness_backend.streams import judge
from hardwareharness_backend.util import clone

from .bindings import expand_bindings
from .models import STREAM_STEPS, iter_steps, schema_hash
from .validation import issue, validate_with_protocols

Record = dict[str, Any]
_STEP_REF = re.compile(r"\bsteps\.([A-Za-z][A-Za-z0-9_-]{0,63})((?:\.[A-Za-z_][A-Za-z0-9_]*)*)")


def compile_plan(
    plan: Record,
    resolver: Any | None,
    plugins: list[Any] | None = None,
    wiring: Any | None = None,
    values: Record | None = None,
) -> Record:
    """Compile ``plan`` for the run parameters ``values`` (one station of a batch, §7.6)."""
    source = plan
    plan, binding_issues = expand_bindings(source, values)
    issues, protocols = validate_with_protocols(plan, resolver, plugins)
    issues = [*binding_issues, *issues]
    bindings: Record = {}
    output_schemas: Record = {}
    available: set[str] = set()

    def compile_steps(
        steps: list[Record],
        path: str,
        inherited: set[str],
        inherited_state: dict[str, set[str]],
    ) -> tuple[set[str], dict[str, set[str]]]:
        current = set(inherited)
        current_state = _copy_state(inherited_state)
        for index, step in enumerate(steps):
            step_path = f"{path}/{index}"
            step_id = str(step.get("id", ""))
            _check_expressions(step, step_path, current, output_schemas, issues)
            if step.get("type") == "InvokeTool" and resolver:
                tool, binding_issues = resolver.resolve(
                    str(step.get("hardwareId", "")), str(step.get("toolName", ""))
                )
                issues.extend(
                    {**item, "path": step_path + item.get("path", "")} for item in binding_issues
                )
                if tool:
                    bindings[step_id] = clone(tool)
                    output_schemas[step_id] = clone(tool.get("resultSchema", {}))
                    if step.get("bindingRevision") != tool.get("bindingRevision"):
                        issues.append(
                            issue(
                                "error",
                                "invoke.binding_changed",
                                "Tool binding changed; explicitly refresh this InvokeTool binding",
                                step_path + "/bindingRevision",
                            )
                        )
                    semantics = tool.get("operationSemantics", {})
                    device_state = current_state.setdefault(str(step.get("hardwareId")), set())
                    missing = set(semantics.get("stateRequirements", [])) - device_state
                    if missing:
                        issues.append(
                            issue(
                                "error",
                                "device.state_requirement",
                                "Device state prerequisites are not established: "
                                + ", ".join(sorted(missing)),
                                step_path,
                            )
                        )
                    device_state.update(str(value) for value in semantics.get("stateEffects", []))
                    _check_argument_types(
                        step,
                        step_path,
                        tool.get("inputSchema", {}),
                        output_schemas,
                        issues,
                    )
            else:
                output_schemas[step_id] = _builtin_output_schema(step)
            kind = step.get("type")
            if kind in {"Sequence", "Group", "Guard"}:  # Guard runs its children in order
                current, current_state = compile_steps(
                    step.get("children", []),
                    step_path + "/children",
                    current,
                    current_state,
                )
            elif kind == "Parallel":
                child_outputs: set[str] = set()
                child_states: list[dict[str, set[str]]] = []
                for child in step.get("children", []):
                    outputs, branch_state = compile_steps(
                        [child], step_path + "/children", current, current_state
                    )
                    child_outputs |= outputs - current
                    child_states.append(branch_state)
                current |= child_outputs
                current_state = _union_states([current_state, *child_states])
            elif kind == "If":
                yes, yes_state = compile_steps(
                    step.get("children", []),
                    step_path + "/children",
                    current,
                    current_state,
                )
                no, no_state = compile_steps(
                    step.get("elseChildren", []),
                    step_path + "/elseChildren",
                    current,
                    current_state,
                )
                current |= yes & no
                current_state = _intersect_states([yes_state, no_state])
            elif kind in {"Repeat", "ForEach", "Retry"}:
                compile_steps(
                    step.get("children", []),
                    step_path + "/children",
                    current,
                    current_state,
                )
            if step_id:
                current.add(step_id)
                available.add(step_id)
        return current, current_state

    regions = plan.get("regions", {})
    guaranteed: set[str] = set()
    guaranteed_state: dict[str, set[str]] = {}
    for region in ("prepare", "test", "cleanup"):
        guaranteed, guaranteed_state = compile_steps(
            regions.get(region, []),
            f"/regions/{region}",
            guaranteed,
            guaranteed_state,
        )

    wiring_revision = _wiring_revision(wiring)
    coverage = _coverage_summary(plan)
    compiled = clone(plan)
    compiled["resolvedBindings"] = bindings
    # §6.4: the run decodes with (and records) exactly the ICDs compiled here.
    frozen = protocols.snapshot()["icds"]
    compiled["icds"] = frozen
    fingerprint = {
        # The source plan: which station a run uses is a run input, like its parameters.
        "plan": {key: value for key, value in source.items() if key not in {"updatedAt"}},
        "bindings": {key: value.get("bindingRevision") for key, value in bindings.items()},
        "icds": {name: entry["icdHash"] for name, entry in frozen.items()},
        "wiringRevision": wiring_revision,
        "issues": issues,
    }
    return {
        "compiledPlan": compiled,
        "issues": issues,
        "valid": not any(item.get("severity") == "error" for item in issues),
        "executionRevision": schema_hash(fingerprint),
        "wiringRevision": wiring_revision,
        "coverage": coverage,
    }


def analyze_plan_draft(
    plan: Record, resolver: Any | None, plugins: list[Any] | None = None, wiring: Any | None = None
) -> Record:
    compiled = compile_plan(plan, resolver, plugins, wiring)
    schemas: Record = {}
    labels: dict[str, str] = {}
    variable_names: set[str] = set()
    for _, step in iter_steps(plan):
        step_id = str(step.get("id", ""))
        if not step_id:
            continue
        labels[step_id] = str(step.get("name") or step.get("type") or step_id)
        if step.get("type") == "InvokeTool" and resolver:
            tool, _ = resolver.resolve(
                str(step.get("hardwareId", "")), str(step.get("toolName", ""))
            )
            schemas[step_id] = clone(tool.get("resultSchema", {})) if tool else {}
        else:
            schemas[step_id] = _builtin_output_schema(step)
        if step.get("type") == "SetVariable" and isinstance(step.get("variable"), str):
            variable_names.add(str(step["variable"]))

    references: dict[str, list[Record]] = {}
    all_step_ids = list(labels)
    parameters = [
        item for item in plan.get("parameters", []) if isinstance(item, dict) and item.get("name")
    ]

    def snapshot_refs(
        step_id: str,
        guaranteed_steps: set[str],
        seen_steps: set[str],
        guaranteed_variables: set[str],
        seen_variables: set[str],
    ) -> None:
        output: list[Record] = []
        for parameter in parameters:
            name = str(parameter["name"])
            output.append(
                {
                    "expression": f"parameters.{name}",
                    "label": str(parameter.get("description") or name),
                    "sourceKind": "parameter",
                    "sourceId": name,
                    "valueType": str(parameter.get("type", "unknown")),
                    "availability": "guaranteed",
                }
            )
        for name in sorted(variable_names):
            availability = (
                "guaranteed"
                if name in guaranteed_variables
                else "conditional"
                if name in seen_variables
                else "unavailable"
            )
            output.append(
                {
                    "expression": f"variables.{name}",
                    "label": name,
                    "sourceKind": "variable",
                    "sourceId": name,
                    "availability": availability,
                    **(
                        {"reason": "变量只在条件路径中赋值"}
                        if availability == "conditional"
                        else {"reason": "变量尚未在此前步骤中赋值"}
                        if availability == "unavailable"
                        else {}
                    ),
                }
            )
        for source_id in all_step_ids:
            availability = (
                "guaranteed"
                if source_id in guaranteed_steps
                else "conditional"
                if source_id in seen_steps
                else "unavailable"
            )
            leaves = _schema_references(schemas.get(source_id, {})) or [([], {})]
            for path, field_schema in leaves:
                suffix = "." + ".".join(path) if path else ""
                output.append(
                    {
                        "expression": f"steps.{source_id}{suffix}",
                        "label": labels[source_id] + (" / " + ".".join(path) if path else ""),
                        "sourceKind": "step",
                        "sourceId": source_id,
                        **({"path": ".".join(path)} if path else {}),
                        **(
                            {"valueType": str(field_schema["type"])}
                            if isinstance(field_schema, dict)
                            and isinstance(field_schema.get("type"), str)
                            else {}
                        ),
                        **(
                            {"unit": str(field_schema["x-hh-unit"])}
                            if isinstance(field_schema, dict) and field_schema.get("x-hh-unit")
                            else {}
                        ),
                        "availability": availability,
                        **(
                            {"reason": "来源步骤只在条件路径中执行"}
                            if availability == "conditional"
                            else {"reason": "来源步骤不会保证在当前步骤之前执行"}
                            if availability == "unavailable"
                            else {}
                        ),
                    }
                )
        references[step_id] = output

    def walk(
        steps: list[Record],
        guaranteed_steps: set[str],
        seen_steps: set[str],
        guaranteed_variables: set[str],
        seen_variables: set[str],
    ) -> tuple[set[str], set[str], set[str], set[str]]:
        current, seen = set(guaranteed_steps), set(seen_steps)
        current_variables, seen_vars = set(guaranteed_variables), set(seen_variables)
        for step in steps:
            step_id = str(step.get("id", ""))
            if step_id:
                snapshot_refs(step_id, current, seen, current_variables, seen_vars)
            kind = step.get("type")
            if kind in {"Sequence", "Group"}:
                current, seen, current_variables, seen_vars = walk(
                    step.get("children", []), current, seen, current_variables, seen_vars
                )
            elif kind == "Parallel":
                branches = [
                    walk([child], current, seen, current_variables, seen_vars)
                    for child in step.get("children", [])
                ]
                for child_current, child_seen, child_variables, child_seen_vars in branches:
                    current |= child_current - guaranteed_steps
                    seen |= child_seen
                    current_variables |= child_variables - guaranteed_variables
                    seen_vars |= child_seen_vars
            elif kind == "If":
                yes = walk(step.get("children", []), current, seen, current_variables, seen_vars)
                no = walk(step.get("elseChildren", []), current, seen, current_variables, seen_vars)
                current |= yes[0] & no[0]
                seen |= yes[1] | no[1]
                current_variables |= yes[2] & no[2]
                seen_vars |= yes[3] | no[3]
            elif kind in {"Repeat", "ForEach", "Retry"}:
                child = walk(step.get("children", []), current, seen, current_variables, seen_vars)
                seen |= child[1] | child[0]
                seen_vars |= child[3] | child[2]
            if kind == "SetVariable" and isinstance(step.get("variable"), str):
                current_variables.add(str(step["variable"]))
                seen_vars.add(str(step["variable"]))
            if step_id:
                current.add(step_id)
                seen.add(step_id)
        return current, seen, current_variables, seen_vars

    current_steps: set[str] = set()
    seen_steps: set[str] = set()
    current_variables: set[str] = set()
    seen_variables: set[str] = set()
    regions = plan.get("regions", {})
    for region in ("prepare", "test", "cleanup"):
        current_steps, seen_steps, current_variables, seen_variables = walk(
            regions.get(region, []),
            current_steps,
            seen_steps,
            current_variables,
            seen_variables,
        )
    return {"issues": compiled["issues"], "referencesByStepId": references}


def _schema_references(
    schema: Any, prefix: list[str] | None = None
) -> list[tuple[list[str], Record]]:
    path = prefix or []
    if not isinstance(schema, dict):
        return []
    properties = schema.get("properties")
    if isinstance(properties, dict) and properties:
        output: list[tuple[list[str], Record]] = []
        for key, child in properties.items():
            nested = _schema_references(child, [*path, str(key)])
            output.extend(nested or [([*path, str(key)], child if isinstance(child, dict) else {})])
        return output
    return [(path, schema)] if path else []


def _copy_state(value: dict[str, set[str]]) -> dict[str, set[str]]:
    return {hardware_id: set(states) for hardware_id, states in value.items()}


def _union_states(values: list[dict[str, set[str]]]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for value in values:
        for hardware_id, states in value.items():
            result.setdefault(hardware_id, set()).update(states)
    return result


def _intersect_states(values: list[dict[str, set[str]]]) -> dict[str, set[str]]:
    if not values:
        return {}
    hardware_ids = set.intersection(*(set(value) for value in values))
    return {
        hardware_id: set.intersection(*(value[hardware_id] for value in values))
        for hardware_id in hardware_ids
    }


def _check_expressions(
    step: Record, path: str, available: set[str], schemas: Record, issues: list[Record]
) -> None:
    expressions: list[tuple[str, str]] = []
    for key, value in step.items():
        if (key.endswith("Expression") or key in {"expression", "condition"}) and isinstance(
            value, str
        ):
            expressions.append((key, value))

    def nested(value: Any, location: str) -> None:
        if isinstance(value, dict):
            if set(value) == {"expression"} and isinstance(value["expression"], str):
                expressions.append((location, value["expression"]))
            else:
                for key, item in value.items():
                    nested(item, location + "/" + str(key))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                nested(item, location + f"/{index}")

    nested(step.get("arguments", {}), "arguments")
    for field, expression in expressions:
        for match in _STEP_REF.finditer(expression):
            step_id, suffix = match.group(1), match.group(2)
            if step_id not in available:
                issues.append(
                    issue(
                        "error",
                        "expression.control_flow",
                        f"Referenced step {step_id} is not guaranteed to execute first",
                        path + "/" + field,
                    )
                )
                continue
            fields = [part for part in suffix.split(".") if part]
            known = _schema_path(schemas.get(step_id, {}), fields)
            if known is False:
                issues.append(
                    issue(
                        "error",
                        "expression.field_missing",
                        f"Output field does not exist: steps.{step_id}{suffix}",
                        path + "/" + field,
                    )
                )
            elif known is None:
                issues.append(
                    issue(
                        "warning",
                        "expression.field_unproven",
                        f"Tool schema cannot prove output path steps.{step_id}{suffix}",
                        path + "/" + field,
                    )
                )


def _schema_path(schema: Any, fields: list[str]) -> bool | None:
    resolved = _resolve_schema_path(schema, fields)
    return resolved if isinstance(resolved, bool) else None if resolved is None else True


def _resolve_schema_path(schema: Any, fields: list[str]) -> Record | bool | None:
    if not fields:
        return schema if isinstance(schema, dict) else None
    if not isinstance(schema, dict) or not schema:
        return None
    if "allOf" in schema and len(schema["allOf"]) == 1:
        child = clone(schema["allOf"][0])
        if isinstance(child, dict) and "$ref" in child and schema.get("$defs"):
            ref = str(child["$ref"])
            if ref.startswith("#/$defs/"):
                resolved: Any = schema
                for token in ref[2:].split("/"):
                    resolved = resolved.get(token) if isinstance(resolved, dict) else None
                child = resolved
        return _resolve_schema_path(child, fields)
    properties = schema.get("properties")
    if isinstance(properties, dict):
        if fields[0] not in properties:
            return None if schema.get("additionalProperties", True) else False
        return _resolve_schema_path(properties[fields[0]], fields[1:])
    return None


def _check_argument_types(
    step: Record,
    path: str,
    input_schema: Record,
    outputs: Record,
    issues: list[Record],
) -> None:
    properties = input_schema.get("properties", {})
    if not isinstance(properties, dict):
        return
    for name, value in step.get("arguments", {}).items():
        if not isinstance(value, dict) or set(value) != {"expression"}:
            continue
        match = _STEP_REF.fullmatch(str(value["expression"]).strip())
        expected = properties.get(name)
        if not match or not isinstance(expected, dict):
            continue
        actual = _resolve_schema_path(
            outputs.get(match.group(1), {}),
            [part for part in match.group(2).split(".") if part],
        )
        if isinstance(actual, dict) and not _compatible_types(actual, expected):
            issues.append(
                issue(
                    "error",
                    "expression.type_mismatch",
                    f"Expression result is incompatible with argument {name}",
                    path + f"/arguments/{name}/expression",
                )
            )


def _compatible_types(actual: Record, expected: Record) -> bool:
    actual_type, expected_type = actual.get("type"), expected.get("type")
    if actual_type is None or expected_type is None:
        return True
    actual_types = set(actual_type if isinstance(actual_type, list) else [actual_type])
    expected_types = set(expected_type if isinstance(expected_type, list) else [expected_type])
    if "integer" in actual_types:
        actual_types.add("number")
    if "integer" in expected_types:
        expected_types.add("number")
    return bool(actual_types & expected_types)


def _builtin_output_schema(step: Record) -> Record:
    kind = step.get("type")
    if kind in STREAM_STEPS:
        properties: Record = {
            "verdict": {"type": "string", "enum": ["pass", "fail", "inconclusive"]},
            "reason": {"type": "string"},
            "message": {"type": "string"},
            "metrics": {"type": "object"},
            "evidenceType": {"type": "string", "enum": list(judge.EVIDENCE_TYPES)},
        }
        capture = step.get("capture")
        if kind == "Expect":
            properties.update(
                matchT={"type": "number"}, latencyMs={"type": "number"}, record={"type": "object"}
            )
        if kind == "Expect" and isinstance(capture, dict) and capture:
            # §7.5: only declared names exist, so steps.<id>.captures.<typo> fails to compile.
            properties["captures"] = {
                "type": "object",
                "properties": {
                    str(name): {"type": ["string", "null"]}
                    if isinstance(spec, dict) and "regex" in spec
                    else {}
                    for name, spec in capture.items()
                },
                "additionalProperties": False,
            }
        return {
            "type": "object",
            "properties": properties,
            "required": ["verdict"],
            "additionalProperties": True,
        }
    if kind in {"Repeat", "ForEach", "Retry"}:
        return {
            "type": "object",
            "properties": {"iterations": {"type": "integer"}, "attempts": {"type": "integer"}},
        }
    return {}


def _wiring_revision(wiring: Any | None) -> str:
    if wiring is None or not hasattr(wiring, "snapshot"):
        return "unavailable"
    return str(wiring.snapshot().get("wiringRevision", "unknown"))


def _coverage_summary(plan: Record) -> Record:
    requirements = {
        str(item.get("id")): item
        for item in plan.get("requirements", [])
        if isinstance(item, dict) and item.get("id")
    }
    linked = {identifier: 0 for identifier in requirements}
    for _, step in iter_steps(plan):
        if step.get("type") not in STREAM_STEPS and not (
            step.get("type") == "InvokeTool" and step.get("assertions")
        ):
            continue
        for identifier in step.get("requirementIds", []):
            if str(identifier) in linked:
                linked[str(identifier)] += 1
    return {
        "requirements": [
            {
                "requirementId": identifier,
                "name": item.get("name", identifier),
                "status": "NotRun",
                "assertionCount": linked[identifier],
            }
            for identifier, item in requirements.items()
        ],
        "total": len(requirements),
        "linked": sum(1 for count in linked.values() if count),
    }
