"""Run the independent Python gates without relying on the caller's working directory."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

LINT_IMPORTS = (
    "import sys; from importlinter.cli import lint_imports_command; "
    "sys.exit(lint_imports_command())"
)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    commands = [
        ["-m", "ruff", "check", "src", "tests", "scripts"],
        ["-m", "ruff", "format", "--check", "src", "tests", "scripts"],
        ["-m", "mypy", "--strict"],
        # Layering (design doc §9.2), contracts in pyproject.toml [tool.importlinter].
        ["-c", LINT_IMPORTS],
        [
            "-m",
            "pytest",
            "--cov",
            "--cov-report=json:../output/verification/python-coverage.json",
            "--cov-report=term:skip-covered",
        ],
        ["scripts/check_coverage.py"],
    ]
    for arguments in commands:
        subprocess.run([sys.executable, *arguments], cwd=root, check=True)


if __name__ == "__main__":
    main()
