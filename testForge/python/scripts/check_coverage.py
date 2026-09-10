"""Lock each translated package's line and branch floors to the original TS baseline.

Different coverage engines count different constructs; passing these floors complements
the assertion mapping and differential fixtures, and does not prove semantic equivalence.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def main() -> None:
    reports = Path(__file__).resolve().parents[1] / "reports"
    baseline = json.loads((reports / "coverage-baseline-by-package.json").read_text("utf-8"))
    coverage = json.loads((reports / "python-coverage.json").read_text("utf-8"))
    output: dict[str, Any] = {}
    failures = []
    for package, original in baseline.items():
        summaries = [
            file["summary"]
            for name, file in coverage["files"].items()
            if "/" + package.replace("-", "_") + "/" in name.replace("\\", "/")
        ]
        if not summaries:
            failures.append(f"{package}: no coverage data")
            continue
        translated = {
            "lines": [
                sum(s["covered_lines"] for s in summaries),
                sum(s["num_statements"] for s in summaries),
            ],
            "branches": [
                sum(s["covered_branches"] for s in summaries),
                sum(s["num_branches"] for s in summaries),
            ],
        }
        output[package] = {"typescript": original, "python": translated}
        for metric, (covered, total) in translated.items():
            ts_covered, ts_total = original[metric]
            percent = covered / total if total else 1
            if percent + 1e-12 < ts_covered / ts_total:
                failures.append(f"{package} {metric}: {percent:.2%} < {ts_covered / ts_total:.2%}")
    (reports / "coverage-comparison.json").write_text(
        json.dumps(output, indent=2) + "\n", encoding="utf-8"
    )
    if failures:
        raise SystemExit("Coverage regressions:\n" + "\n".join(failures))
    print("All eight Python packages meet the original line and branch coverage floors")


if __name__ == "__main__":
    main()
