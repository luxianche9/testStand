"""Optional machine-readable link between original Vitest cases and pytest results."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

_results: dict[str, str] = {}
_source_hashes: dict[str, str] = {}


def source_hashes() -> dict[str, str]:
    root = Path(__file__).resolve().parents[1]
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


def pytest_sessionstart(session: pytest.Session) -> None:
    _results.clear()
    _source_hashes.clear()
    _source_hashes.update(source_hashes())


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--spec-report", help="Write collected TS case links and pytest outcomes")


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    if report.when == "call" or report.failed:
        _results[report.nodeid] = report.outcome


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    target = session.config.getoption("spec_report")
    if not isinstance(target, str):
        return
    items: list[dict[str, Any]] = []
    for item in session.items:
        original = [str(value) for marker in item.iter_markers("ts_case") for value in marker.args]
        items.append(
            {
                "nodeid": item.nodeid,
                "tsCases": original,
                "outcome": _results.get(item.nodeid, "not-run"),
            }
        )
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "exitstatus": exitstatus,
                "sourceHashesBefore": _source_hashes,
                "sourceHashesAfter": source_hashes(),
                "tests": items,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
