from __future__ import annotations

import json
from pathlib import Path

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.workspace.environment import EnvironmentManager
from hardwareharness_backend.workspace.references import ReferenceService


def test_bundled_docs_are_available_without_project_and_paginate() -> None:
    service = ReferenceService()
    index = service.read({"limit": 1})
    assert index["references"][0]["referenceId"] == "hh-sdk"
    assert index["hasMore"] and index["nextOffset"] == 1
    page = service.read({"referenceId": "hh-sdk", "limit": 1})
    assert page["lines"][0]["line"] == 1
    assert page["sources"][0]["contractRevision"] == "2026-09-15.1"
    assert service.read({"query": "result_mode"})["total"] > 0
    assert service.read({"referenceId": "hh-sdk", "query": "mock"})["total"] == 0


def test_scaffold_preserves_user_guide_and_publishes_versioned_release(tmp_path: Path) -> None:
    docs = tmp_path / ".hardwareharness/docs"
    docs.mkdir(parents=True)
    guide = docs / "hardwareharness-sdk.md"
    guide.write_text("User notes", encoding="utf-8")
    EnvironmentManager().scaffold(str(tmp_path))
    assert guide.read_text("utf-8") == "User notes"
    index = json.loads((docs / "hardwareharness-reference-index.json").read_text("utf-8"))
    assert index["contractRevision"] == "2026-09-15.1"
    assert "result_mode" in (docs / index["sdkGuide"]).read_text("utf-8")


def test_register_copies_evidence_requires_current_hash_and_paginates_long_lines(
    tmp_path: Path,
) -> None:
    source = tmp_path / "board.md"
    source.write_text("Pin\n" + "x" * 2500 + "\n", encoding="utf-8")
    service = ReferenceService(str(tmp_path))
    value = {"referenceId": "board", "title": "Board wiring", "path": "board.md"}
    registered = service.register(value)
    source.unlink()
    page = service.read({"referenceId": "board", "limit": 2})
    assert page["lines"][1]["text"] == "x" * 1000
    next_page = service.read({"referenceId": "board", "offset": page["nextOffset"]})
    assert next_page["lines"][0]["column"] == 1001
    assert next_page["lines"][1]["column"] == 2001
    source.write_text("Updated", encoding="utf-8")
    with pytest.raises(AppError, match="expectedHash"):
        service.register(value)
    assert (
        service.register({**value, "expectedHash": registered["sha256"]})["sha256"]
        != registered["sha256"]
    )


@pytest.mark.parametrize(
    "path", ["../outside.txt", "C:/Windows/system.ini", ".hardwareharness/logs/x.txt", "x.pdf"]
)
def test_reference_import_is_confined_to_supported_user_files(tmp_path: Path, path: str) -> None:
    with pytest.raises(AppError):
        ReferenceService(str(tmp_path)).register(
            {"referenceId": "board", "title": "Board", "path": path}
        )


def test_bundled_id_cannot_be_overwritten(tmp_path: Path) -> None:
    with pytest.raises(AppError, match="referenceId"):
        ReferenceService(str(tmp_path)).register(
            {"referenceId": "hh-sdk", "title": "wrong", "path": "x.md"}
        )
