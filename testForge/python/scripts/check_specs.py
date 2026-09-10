"""Fail if an original expanded Vitest specification has no passing Python equivalent."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any


def python_assertions(root: Path, nodeid: str) -> list[dict[str, Any]]:
    parts = nodeid.split("::")
    path = root / parts[0].replace("\\", "/")
    name = parts[-1].split("[", 1)[0]
    source = path.read_text("utf-8")
    result: list[dict[str, Any]] = []
    for function in ast.walk(ast.parse(source)):
        if (
            not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef)
            or function.name != name
        ):
            continue
        for node in ast.walk(function):
            if isinstance(node, ast.Assert) or (
                isinstance(node, ast.Call)
                and (
                    isinstance(node.func, ast.Name)
                    and node.func.id == "assert_type"
                    or isinstance(node.func, ast.Attribute)
                    and node.func.attr == "raises"
                )
            ):
                result.append({"line": node.lineno, "source": ast.get_source_segment(source, node)})
    return result


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    original = json.loads((root / "reports/ts-packages-results.json").read_text(encoding="utf-8"))
    translated = json.loads((root / "reports/python-spec-results.json").read_text(encoding="utf-8"))
    inventory = json.loads((root / "reports/ts-assertion-inventory.json").read_text("utf-8"))
    output: list[dict[str, Any]] = []
    missing: list[str] = []
    for suite in original["testResults"]:
        filename = "packages/" + suite["name"].replace("\\", "/").split("/packages/", 1)[1]
        for case in suite["assertionResults"]:
            title = case["title"]
            matches = []
            for test in translated["tests"]:
                for link in test["tsCases"]:
                    parts = link.split("::")
                    if parts[0] == filename and parts[-1] == title:
                        matches.append(test)
                        break
            key = filename + "::" + "::".join([*case.get("ancestorTitles", []), title])
            source = next(
                item for item in inventory if item["file"] == filename and item["title"] == title
            )
            if (
                hashlib.sha256((root.parent / filename).read_bytes()).hexdigest()
                != source["sourceHash"]
            ):
                raise SystemExit(f"Original TS assertion inventory is stale: {filename}")
            if not matches or not any(test["outcome"] == "passed" for test in matches):
                missing.append(key)
            output.append(
                {
                    "typescript": key,
                    "python": [test["nodeid"] for test in matches],
                    "passed": any(test["outcome"] == "passed" for test in matches),
                    "originalAssertions": source["assertions"],
                    "pythonAssertions": {
                        test["nodeid"]: python_assertions(root, test["nodeid"]) for test in matches
                    },
                }
            )
    (root / "reports/specification-map.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if missing:
        raise SystemExit("Missing passing specification mappings:\n" + "\n".join(missing))
    print(f"All {len(output)} original expanded Vitest cases have passing Python equivalents")


if __name__ == "__main__":
    main()
