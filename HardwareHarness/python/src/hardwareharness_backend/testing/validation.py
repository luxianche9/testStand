from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

from .expression import evaluate
from .models import BUILTIN_STEPS, CONTAINER_STEPS, STEP_ID, iter_steps

Record = dict[str, Any]


def issue(severity: str, code: str, message: str, path: str = "") -> Record:
    return {"severity": severity, "code": code, "message": message, "path": path}


def validate_plan(
    plan: Any, resolver: Any | None = None, plugins: list[Any] | None = None
) -> list[Record]:
    issues: list[Record] = []
    if not isinstance(plan, dict):
        return [issue("error", "plan.type", "Plan must be an object")]
    if plan.get("schemaVersion") == 1:
        issues.append(
            issue(
                "error",
                "plan.migration_required",
                "schemaVersion 1 plans are read-only and must be explicitly migrated to version 2",
                "/schemaVersion",
            )
        )
    elif plan.get("schemaVersion") != 2:
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
        for field, expression in _expressions(step):
            if expression:
                try:
                    evaluate(
                        expression,
                        {"parameters": {}, "variables": {}, "steps": {}, "item": None, "index": 0},
                    )
                except Exception as error:
                    message = str(error)
                    if "Unknown" not in message:
                        issues.append(
                            issue("error", "expression.invalid", message, path + "/" + field)
                        )
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
