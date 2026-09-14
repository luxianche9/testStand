"""Bind fixed original Vitest evidence to passing tests of the current Python sources.

Historical TS sources may be absent. Their revision, byte hashes, assertions, results and
goldens are preserved in a pinned manifest rather than conditionally skipping hash checks.
"""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any

EVIDENCE_SHA256 = "6d49c1d2025c6d1459555fd5098f433363109b865b89f387f961b666b5c1a35f"


def verify_fixed_evidence(root: Path) -> dict[str, Any]:
    path = root / "reports/original-specification-evidence.json"
    if hashlib.sha256(path.read_bytes()).hexdigest() != EVIDENCE_SHA256:
        raise SystemExit("Original specification evidence manifest changed")
    manifest: dict[str, Any] = json.loads(path.read_text("utf-8"))
    hashes = dict(manifest["evidence"])
    hashes.update({name: item["sha256"] for name, item in manifest["goldens"].items()})
    for name, expected in hashes.items():
        source = root.parent / name
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            raise SystemExit(f"Fixed original specification evidence changed or missing: {name}")
    return manifest


def current_source_hashes(root: Path) -> dict[str, str]:
    files = [root / "pyproject.toml", root / "uv.lock"]
    for directory in ("src", "tests", "scripts"):
        files += [
            path
            for path in (root / directory).rglob("*")
            if path.is_file() and path.suffix in {".py", ".json"}
        ]
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(files)
    }


def verify_current_results(root: Path, translated: dict[str, Any]) -> None:
    current = current_source_hashes(root)
    if (
        translated.get("sourceHashesBefore") != current
        or translated.get("sourceHashesAfter") != current
    ):
        raise SystemExit("Pytest report is stale or its inputs changed during the test run")
    if translated.get("exitstatus") != 0 or not translated.get("tests"):
        raise SystemExit("Pytest did not complete successfully")
    if any(test["outcome"] != "passed" for test in translated["tests"]):
        raise SystemExit("Pytest contains failed, skipped or unexecuted tests")


def suite_filename(name: str) -> str:
    normalized = name.replace("\\", "/")
    for prefix in ("packages/", "apps/"):
        if normalized.startswith(prefix):
            return normalized
        if "/" + prefix in normalized:
            return prefix + normalized.split("/" + prefix, 1)[1]
    raise SystemExit(f"Unknown original test source path: {name}")


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
    manifest = verify_fixed_evidence(root)
    original = json.loads((root / "reports/ts-packages-results.json").read_text(encoding="utf-8"))
    migrations = json.loads((root / "reports/ts-migrations-results.json").read_text("utf-8"))
    translated = json.loads((root / "reports/python-spec-results.json").read_text(encoding="utf-8"))
    verify_current_results(root, translated)
    inventory = json.loads((root / "reports/ts-assertion-inventory.json").read_text("utf-8"))
    inventory += json.loads(
        (root / "reports/ts-migration-assertion-inventory.json").read_text("utf-8")
    )
    source_hashes = json.loads((root / "reports/original-source-hashes.json").read_text("utf-8"))
    if len(source_hashes["files"]) != manifest["sourceFileCount"]:
        raise SystemExit("Original source hash inventory is incomplete")
    for report, count in ((original, 117), (migrations, 3)):
        cases = [case for suite in report["testResults"] for case in suite["assertionResults"]]
        if len(cases) != count or any(case["status"] != "passed" for case in cases):
            raise SystemExit(f"Original {count}-case Vitest evidence is incomplete")
    output: list[dict[str, Any]] = []
    missing: list[str] = []
    for suite in [*original["testResults"], *migrations["testResults"]]:
        filename = suite_filename(suite["name"])
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
            sources = [
                item for item in inventory if item["file"] == filename and item["title"] == title
            ]
            if len(sources) != 1:
                raise SystemExit(f"Ambiguous/missing original assertion inventory: {key}")
            source = sources[0]
            if (
                source_hashes["files"][filename]["sha256"] != source["sourceHash"]
                or not source["assertions"]
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
    print(
        "All 117 original package cases + 3 desktop migration cases "
        f"({len(output)} total) have current passing Python equivalents; fixed evidence verified"
    )


if __name__ == "__main__":
    main()
