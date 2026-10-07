from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

from teststand_backend.streams import judge

from .bindings import expand_bindings
from .expression import CONTEXT_NAMES, evaluate, references_context
from .expression import check as check_expression
from .manual import manual_check_issues
from .models import BUILTIN_STEPS, CONTAINER_STEPS, STEP_ID, STREAM_STEPS, iter_steps
from .protocols import PlanProtocols, encode_target
from .protocols import resolve as resolve_protocols

Record = dict[str, Any]


def issue(severity: str, code: str, message: str, path: str = "") -> Record:
    return {"severity": severity, "code": code, "message": message, "path": path}


def validate_plan(
    plan: Any,
    resolver: Any | None = None,
    plugins: list[Any] | None = None,
    values: Record | None = None,
) -> list[Record]:
    """Issues of ``plan`` with its bindings (§7.6) expanded from ``values`` or the defaults."""
    if not isinstance(plan, dict):
        return validate_with_protocols(plan, resolver, plugins)[0]
    expanded, binding_issues = expand_bindings(plan, values)
    return [*binding_issues, *validate_with_protocols(expanded, resolver, plugins)[0]]


def validate_with_protocols(
    plan: Any, resolver: Any | None = None, plugins: list[Any] | None = None
) -> tuple[list[Record], PlanProtocols]:
    """The issues plus the plan's resolved protocol bindings (the ICDs it will freeze).

    ``plan`` must already have its device bindings expanded (``expand_bindings``).
    """
    if not isinstance(plan, dict):
        return [issue("error", "plan.type", "Plan must be an object")], PlanProtocols({}, [])
    protocols, issues = resolve_protocols(
        plan,
        getattr(resolver, "icd", None),
        lambda hardware_id: _declared_streams(resolver, hardware_id),
    )
    return _validate(plan, resolver, plugins, protocols) + issues, protocols


def _declared_streams(resolver: Any | None, hardware_id: str) -> dict[str, str] | None:
    streams = getattr(resolver, "streams", None)
    declared = streams(hardware_id) if streams is not None else None
    return declared if isinstance(declared, dict) else None


def _validate(
    plan: Record, resolver: Any | None, plugins: list[Any] | None, protocols: PlanProtocols
) -> list[Record]:
    issues: list[Record] = []
    if plan.get("schemaVersion") != 2:
        issues.append(
            issue("error", "plan.schemaVersion", "schemaVersion must be 2", "/schemaVersion")
        )
    for key in ("id", "name"):
        if not isinstance(plan.get(key), str) or not plan[key].strip():
            issues.append(issue("error", f"plan.{key}", f"{key} is required", f"/{key}"))
    if not isinstance(plan.get("revision"), int) or plan.get("revision", 0) < 1:
        issues.append(
            issue("error", "plan.revision", "revision must be a positive integer", "/revision")
        )
    regions = plan.get("regions")
    if not isinstance(regions, dict):
        issues.append(issue("error", "plan.regions", "regions is required", "/regions"))
        return issues
    for region in ("prepare", "test", "cleanup"):
        if not isinstance(regions.get(region), list):
            issues.append(
                issue("error", "plan.region", f"{region} must be an array", f"/regions/{region}")
            )
    plugin_by_type = {plugin.type_name: plugin for plugin in (plugins or [])}
    known = BUILTIN_STEPS | set(plugin_by_type)
    seen: set[str] = set()
    anchors: set[str] = set()
    for path, step in iter_steps(plan):
        step_id = step.get("id")
        if not isinstance(step_id, str) or not STEP_ID.fullmatch(step_id):
            issues.append(
                issue(
                    "error",
                    "step.id",
                    "Step id must start with a letter and contain only letters, digits, _ or -",
                    path + "/id",
                )
            )
        elif step_id in seen:
            issues.append(
                issue("error", "step.id.duplicate", f"Duplicate step id {step_id}", path + "/id")
            )
        else:
            seen.add(step_id)
        step_type = step.get("type")
        if step_type not in known:
            issues.append(
                issue("error", "step.type", f"Unknown step type {step_type}", path + "/type")
            )
            continue
        plugin = plugin_by_type.get(str(step_type))
        if isinstance(step.get("settings"), dict):
            issues.append(
                issue(
                    "error",
                    "step.settings",
                    "Step fields go directly on the step; move them out of settings",
                    path + "/settings",
                )
            )
        if plugin:
            try:
                plugin_issues = plugin.validate(step)
            except Exception as plugin_error:
                issues.append(
                    issue(
                        "error",
                        "plugin.validation_failed",
                        f"Plugin validation failed: {plugin_error}",
                        path,
                    )
                )
            else:
                for plugin_issue in plugin_issues:
                    relative = str(plugin_issue.get("path", ""))
                    issues.append({**plugin_issue, "path": path + relative})
        if step_type in CONTAINER_STEPS and not isinstance(step.get("children", []), list):
            issues.append(
                issue(
                    "error",
                    "step.children",
                    "Container children must be an array",
                    path + "/children",
                )
            )
        if step_type == "ManualCheck":
            issues.extend(
                issue("error", code, message, path + relative)
                for code, message, relative in manual_check_issues(step)
            )
        if step_type == "PublishResult" and "evidenceType" in step:
            grade = step["evidenceType"]
            if grade not in judge.EVIDENCE_TYPES:
                issues.append(
                    issue(
                        "error",
                        "evidence.type",
                        f"evidenceType must be one of {', '.join(judge.EVIDENCE_TYPES)}",
                        path + "/evidenceType",
                    )
                )
            elif grade == "S" and step.get("verdict") in {"Pass", "Fail"}:
                issues.append(
                    issue(
                        "error",
                        "evidence.setpoint",
                        "A setpoint shadow (S) cannot decide Pass or Fail (section 7.7)",
                        path + "/verdict",
                    )
                )
        if step_type == "InvokeTool":
            if step.get("errorPolicy", "error") not in {"error", "fail"}:
                issues.append(
                    issue(
                        "error",
                        "invoke.error_policy",
                        "errorPolicy must be error or fail",
                        path + "/errorPolicy",
                    )
                )
            for field in ("hardwareId", "toolName", "bindingRevision"):
                if not isinstance(step.get(field), str) or not step[field]:
                    issues.append(
                        issue("error", "invoke.binding", f"{field} is required", path + "/" + field)
                    )
            if resolver and all(
                isinstance(step.get(key), str) and step.get(key)
                for key in ("hardwareId", "toolName")
            ):
                resolved, binding_issues = resolver.resolve(step["hardwareId"], step["toolName"])
                issues.extend(
                    {**item, "path": path + item.get("path", "")} for item in binding_issues
                )
                if resolved and step.get("bindingRevision") != resolved.get("bindingRevision"):
                    issues.append(
                        issue(
                            "error",
                            "invoke.binding_changed",
                            "Tool binding changed; explicitly refresh the binding",
                            path + "/bindingRevision",
                        )
                    )
                if resolved:
                    arguments = step.get("arguments", {})
                    if isinstance(step.get("encode"), dict) and isinstance(arguments, dict):
                        target = encode_target(step["encode"], resolved.get("inputSchema", {}))
                        if target is None:
                            issues.append(
                                issue(
                                    "error",
                                    "invoke.encode",
                                    f"{step['toolName']} has no argument for the encoded frame; "
                                    "set encode.argument",
                                    path + "/encode",
                                )
                            )
                        elif target in arguments:
                            issues.append(
                                issue(
                                    "error",
                                    "invoke.encode",
                                    f"arguments.{target} is filled by encode; remove it",
                                    path + f"/arguments/{target}",
                                )
                            )
                        else:
                            arguments = {**arguments, target: "00"}
                    for error in Draft202012Validator(resolved.get("inputSchema", {})).iter_errors(
                        arguments
                    ):
                        bound: Any = arguments
                        for part in error.path:
                            if isinstance(bound, (dict, list)):
                                bound = bound[part]
                        if isinstance(bound, dict) and set(bound) == {"expression"}:
                            continue
                        issues.append(
                            issue(
                                "error",
                                "invoke.arguments",
                                error.message,
                                path + "/arguments" + "".join(f"/{part}" for part in error.path),
                            )
                        )
        if step_type == "InvokeTool":
            issues.extend(_invoke_judging(step, path, anchors))
        if step_type in STREAM_STEPS:
            issues.extend(_stream_step(step, path, resolver, anchors, protocols))
        for field, expression in _expressions(step):
            if expression:
                issues.extend(_expression_issues(expression, path + "/" + field))
        if step_type == "Retry":
            for child_path, child in _descendants(step, path):
                if child.get("type") == "InvokeTool" and resolver:
                    tool, _ = resolver.resolve(
                        str(child.get("hardwareId", "")), str(child.get("toolName", ""))
                    )
                    semantics = (tool or {}).get("operationSemantics", {})
                    if semantics.get("retry") not in {"safe", "before_dispatch"}:
                        issues.append(
                            issue(
                                "error",
                                "retry.unsafe",
                                "Retry contains a non-idempotent hardware operation",
                                child_path,
                            )
                        )
    return issues


def _expression_issues(expression: str, where: str) -> list[Record]:
    """Static type check (§7.3); constant expressions are also evaluated once."""
    found = check_expression(expression)
    if not found and not references_context(expression):
        try:
            evaluate(expression, {name: None for name in CONTEXT_NAMES})
        except Exception as error:
            found = [("expression.invalid", str(error))]
    return [issue("error", code, message, where) for code, message in found]


def _invoke_judging(step: Record, path: str, anchors: set[str]) -> list[Record]:
    issues: list[Record] = []
    anchor = step.get("anchor")
    if anchor is not None:
        if not isinstance(anchor, str) or not anchor:
            issues.append(
                issue("error", "anchor.name", "anchor must be a non-empty string", path + "/anchor")
            )
        else:
            anchors.add(anchor)
    if "assertions" in step:
        assertions = step["assertions"]
        if not isinstance(assertions, list) or not assertions:
            return [
                *issues,
                issue(
                    "error",
                    "assertions.empty",
                    "assertions must be a non-empty array",
                    path + "/assertions",
                ),
            ]
        for index, assertion in enumerate(assertions):
            message = None if _bound_later(assertion) else judge.assertion_error(assertion)
            if message is None and isinstance(assertion, dict):
                root = str(assertion.get("metric", "")).split(".")[0]
                if root not in {"result", "timing", "arguments"}:
                    message = "metric must start with result., timing. or arguments."
            if message:
                issues.append(
                    issue("error", "assertion.invalid", message, f"{path}/assertions/{index}")
                )
    return issues


def _stream_step(
    step: Record, path: str, resolver: Any | None, anchors: set[str], protocols: PlanProtocols
) -> list[Record]:
    """Static checks of an Observe / Expect / Guard step against the declared streams."""
    issues: list[Record] = []
    kind = step["type"]
    for field in ("hardwareId", "streamId"):
        if not isinstance(step.get(field), str) or not step[field]:
            issues.append(
                issue("error", "stream.binding", f"{field} is required", path + "/" + field)
            )
    if issues:
        return issues
    declared = _declared_streams(resolver, step["hardwareId"])
    derived = protocols.derived(step["hardwareId"], step["streamId"])
    stream_type: str | None = derived.stream.stream_type if derived is not None else None
    if declared is not None and derived is None:
        declared = {**declared, **protocols.streams(step["hardwareId"])}
        stream_type = declared.get(step["streamId"])
        if stream_type is None:
            names = ", ".join(sorted(declared)) or "none"
            issues.append(
                issue(
                    "error",
                    "stream.missing",
                    f"{step['hardwareId']} has no stream {step['streamId']}; declared: {names}",
                    path + "/streamId",
                )
            )
    # §7.7: a setpoint shadow (the value last written, not a measurement) is never judgement
    # evidence. Descriptor ``kind`` is only known here once the device's streams were listed;
    # otherwise ``judge._graded`` downgrades such verdicts to inconclusive at run time.
    describe = getattr(resolver, "stream_descriptors", None)
    descriptors = describe(step["hardwareId"]) if describe is not None and derived is None else None
    descriptor = (descriptors or {}).get(step["streamId"])
    if isinstance(descriptor, dict) and judge.is_setpoint(descriptor):
        issues.append(
            issue(
                "error",
                "evidence.setpoint",
                f"{step['streamId']} is a setpoint shadow stream and cannot be judgement "
                "evidence; observe a measured stream instead",
                path + "/streamId",
            )
        )

    def check_anchor(name: Any, where: str) -> None:
        if not isinstance(name, str) or not name:
            issues.append(issue("error", "anchor.name", "anchor is required", where))
        elif name not in anchors:
            issues.append(
                issue(
                    "error",
                    "anchor.undefined",
                    f"anchor {name!r} is not set by an earlier InvokeTool step",
                    where,
                )
            )

    def check_number(value: Any, where: str, minimum: float, strict: bool = False) -> None:
        if _bound_later(value):
            return
        if not _is_number(value) or value < minimum or (strict and value == minimum):
            relation = ">" if strict else ">="
            issues.append(
                issue("error", "stream.number", f"must be a number {relation} {minimum:g}", where)
            )

    if kind == "Observe":
        window = step.get("window")
        if not isinstance(window, dict):
            issues.append(
                issue(
                    "error",
                    "observe.window",
                    "window {anchor, startMs?, endMs} is required",
                    path + "/window",
                )
            )
        else:
            check_anchor(window.get("anchor"), path + "/window/anchor")
            start, end = window.get("startMs", 0), window.get("endMs")
            if not (_bound_later(start) or _bound_later(end)) and not (
                _is_number(start) and _is_number(end) and end > start
            ):
                issues.append(
                    issue(
                        "error",
                        "observe.window",
                        "window.endMs must be a number greater than startMs",
                        path + "/window",
                    )
                )
        assertions = step.get("assertions")
        if not isinstance(assertions, list) or not assertions:
            issues.append(
                issue(
                    "error",
                    "assertions.empty",
                    "assertions must be a non-empty array",
                    path + "/assertions",
                )
            )
        else:
            for index, assertion in enumerate(assertions):
                if _bound_later(assertion):
                    continue
                message = judge.assertion_error(assertion)
                if message is None and stream_type is not None:
                    message = judge.metric_error(stream_type, str(assertion["metric"]))
                if message:
                    issues.append(
                        issue("error", "assertion.invalid", message, f"{path}/assertions/{index}")
                    )
        if "minSamples" in step:
            check_number(step["minSamples"], path + "/minSamples", 1)
    elif kind == "Expect":
        check_anchor(step.get("anchor"), path + "/anchor")
        check_number(step.get("withinMs"), path + "/withinMs", 0, strict=True)
        if "offsetMs" in step:
            check_number(step["offsetMs"], path + "/offsetMs", float("-inf"))
        issues.extend(_match(step.get("match"), stream_type, path + "/match", condition=False))
        capture = step.get("capture")
        if capture is not None and not _bound_later(capture):
            message = judge.capture_error(stream_type, capture)
            if message:
                issues.append(issue("error", "expect.capture", message, path + "/capture"))
    else:
        if step.get("onViolation", "abort") not in {"abort", "fail"}:
            issues.append(
                issue(
                    "error",
                    "guard.on_violation",
                    "onViolation must be abort or fail",
                    path + "/onViolation",
                )
            )
        if not step.get("children"):
            issues.append(
                issue(
                    "error",
                    "guard.children",
                    "Guard needs child steps to watch over",
                    path + "/children",
                )
            )
        issues.extend(
            _match(step.get("condition"), stream_type, path + "/condition", condition=True)
        )
    return issues


def _match(match: Any, stream_type: str | None, where: str, *, condition: bool) -> list[Record]:
    what = "condition" if condition else "match"
    if not isinstance(match, dict):
        return [issue("error", f"stream.{what}", f"{what} must be an object", where)]
    if stream_type is None or _bound_later(match):
        return []
    message = judge.match_error(stream_type, match, condition=condition)
    return [issue("error", f"stream.{what}", message, where)] if message else []


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _bound_later(value: Any) -> bool:
    """``{expression}`` values (anywhere inside) are only known at run time."""
    if isinstance(value, dict):
        if set(value) == {"expression"}:
            return True
        return any(_bound_later(item) for item in value.values())
    if isinstance(value, list):
        return any(_bound_later(item) for item in value)
    return False


def _expressions(step: Record) -> list[tuple[str, str]]:
    output: list[tuple[str, str]] = []
    for key, value in step.items():
        if (key.endswith("Expression") or key in {"expression", "condition"}) and isinstance(
            value, str
        ):
            output.append((key, value))

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            if set(value) == {"expression"} and isinstance(value["expression"], str):
                output.append((path, value["expression"]))
            else:
                for key, item in value.items():
                    visit(item, path + "/" + str(key))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, path + f"/{index}")

    visit(step.get("arguments", {}), "arguments")
    return output


def _descendants(step: Record, path: str) -> list[tuple[str, Record]]:
    output: list[tuple[str, Record]] = []
    for key in ("children", "elseChildren"):
        for index, child in enumerate(step.get(key, [])):
            if isinstance(child, dict):
                child_path = f"{path}/{key}/{index}"
                output.append((child_path, child))
                output.extend(_descendants(child, child_path))
    return output
