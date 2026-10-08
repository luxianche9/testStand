from __future__ import annotations

import runpy
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/generate_operations.py"


def test_typescript_operations_and_openapi_match_python_registry() -> None:
    generator = runpy.run_path(str(SCRIPT))
    assert generator["TARGET"].read_text(encoding="utf-8") == generator["render"](), (
        "packages/contracts/src/operations.generated.ts is stale; "
        "run python/scripts/generate_operations.py"
    )
    assert generator["OPENAPI"].read_text(encoding="utf-8") == generator["render_openapi"](), (
        "packages/contracts/openapi.json is stale; run python/scripts/generate_operations.py"
    )


def test_generated_contracts_are_checked_out_with_lf() -> None:
    """The generators write LF and ``generate-openapi-types.mjs --check`` compares the text, so a
    CRLF checkout (``core.autocrlf``) must not rewrite the generated files."""
    generator = runpy.run_path(str(SCRIPT))
    root = generator["ROOT"]
    if shutil.which("git") is None or not (root.parent / ".git").exists():
        pytest.skip("not a git checkout")
    files = [
        generator["TARGET"],
        generator["OPENAPI"],
        root / "packages/contracts/src/openapi.generated.ts",
    ]
    found = subprocess.run(
        ["git", "check-attr", "eol", "--", *(str(path.relative_to(root)) for path in files)],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    assert [line.rsplit(": ", 1)[-1] for line in found] == ["lf"] * len(files), found
