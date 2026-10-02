"""Enforce per-package line and branch floors from ``coverage-baseline.json``.

The floors are ``[covered, total]`` per ``hardwareharness_backend`` subpackage; a package's
coverage ratio may not fall below its recorded ratio.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    reports = root.parent / "output/verification"
    baseline = json.loads((root / "coverage-baseline.json").read_text("utf-8"))
    coverage = json.loads((reports / "python-coverage.json").read_text("utf-8"))
    output: dict[str, Any] = {}
    failures = []
    for package, floor in baseline.items():
        summaries = [
            file["summary"]
            for name, file in coverage["files"].items()
            if "/" + package + "/" in name.replace("\\", "/")
        ]
        if not summaries:
            failures.append(f"{package}: no coverage data")
            continue
        actual = {
            "lines": [
                sum(s["covered_lines"] for s in summaries),
                sum(s["num_statements"] for s in summaries),
            ],
            "branches": [
                sum(s["covered_branches"] for s in summaries),
                sum(s["num_branches"] for s in summaries),
            ],
        }
        output[package] = {"minimum": floor, "actual": actual}
        for metric, (covered, total) in actual.items():
            floor_covered, floor_total = floor[metric]
            percent = covered / total if total else 1
            minimum = floor_covered / floor_total if floor_total else 1
            if percent + 1e-12 < minimum:
                failures.append(f"{package} {metric}: {percent:.2%} < {minimum:.2%}")
    (reports / "coverage-comparison.json").write_text(
        json.dumps(output, indent=2) + "\n", encoding="utf-8"
    )
    if failures:
        raise SystemExit("Coverage regressions:\n" + "\n".join(failures))
    print("All packages meet their coverage floors")


if __name__ == "__main__":
    main()
