"""Run the independent Python gates without relying on the caller's working directory."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    commands = [
        ["-m", "ruff", "check", "src", "tests", "scripts"],
        ["-m", "ruff", "format", "--check", "src", "tests", "scripts"],
        ["-m", "mypy", "--strict"],
        [
            "-m",
            "pytest",
            "--cov",
            "--cov-report=json:reports/python-coverage.json",
            "--cov-report=term:skip-covered",
            "--spec-report=reports/python-spec-results.json",
        ],
        ["scripts/check_specs.py"],
        ["scripts/check_coverage.py"],
        ["scripts/protected_baseline.py", "check"],
    ]
    for arguments in commands:
        subprocess.run([sys.executable, *arguments], cwd=root, check=True)


if __name__ == "__main__":
    main()
