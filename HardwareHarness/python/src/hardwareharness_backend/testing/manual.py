"""``ManualCheck`` (design §7.2): the run waits for an operator's judgment, which becomes
M-grade evidence (§7.7). Only a person answers; Agents never hold ``testing.judge``.
"""

from __future__ import annotations

from typing import Any

from hardwareharness_backend.streams import judge

Record = dict[str, Any]
MANUAL_VERDICTS = (judge.PASS, judge.FAIL, judge.INCONCLUSIVE)
DEFAULT_OPTIONS: tuple[Record, ...] = (
    {"label": "通过", "verdict": judge.PASS},
    {"label": "不通过", "verdict": judge.FAIL},
    {"label": "无法判断", "verdict": judge.INCONCLUSIVE},
)


def manual_options(step: Record) -> list[Record]:
    """The answers offered for ``step``; the defaults when it lists none."""
    options = step.get("options")
    if not options:
        return [dict(option) for option in DEFAULT_OPTIONS]
    return [{"label": str(item["label"]), "verdict": str(item["verdict"])} for item in options]


def manual_check_issues(step: Record) -> list[tuple[str, str, str]]:
    """``(code, message, relative path)`` for every malformed field of a ManualCheck step."""
    issues: list[tuple[str, str, str]] = []
    prompt = step.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        issues.append(("manual.prompt", "prompt is required", "/prompt"))
    images = step.get("images", [])
    if not isinstance(images, list) or not all(isinstance(item, str) for item in images):
        issues.append(("manual.images", "images must be an array of strings", "/images"))
    timeout = step.get("timeoutMs")
    if timeout is not None and (
        isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0
    ):
        issues.append(("manual.timeout", "timeoutMs must be a positive integer", "/timeoutMs"))
    options = step.get("options")
    if options is None:
        return issues
    if not isinstance(options, list):
        return [*issues, ("manual.options", "options must be an array", "/options")]
    labels: set[str] = set()
    for index, option in enumerate(options):
        path = f"/options/{index}"
        label = option.get("label") if isinstance(option, dict) else None
        if not isinstance(label, str) or not label.strip():
            issues.append(("manual.option", "Each option needs a label", path + "/label"))
        elif label in labels:
            issues.append(("manual.option", f"Duplicate option {label}", path + "/label"))
        else:
            labels.add(label)
        verdict = option.get("verdict") if isinstance(option, dict) else None
        if verdict not in MANUAL_VERDICTS:
            issues.append(
                (
                    "manual.option",
                    f"verdict must be one of {', '.join(MANUAL_VERDICTS)}",
                    path + "/verdict",
                )
            )
    return issues
