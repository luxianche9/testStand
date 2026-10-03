from __future__ import annotations

import runpy
from pathlib import Path

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
