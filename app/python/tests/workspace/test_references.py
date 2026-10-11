from __future__ import annotations

from pathlib import Path

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.workspace.references import ReferenceService


def test_bundled_docs_are_available_without_project_and_paginate() -> None:
    service = ReferenceService()
    index = service.read({"limit": 1})
    assert index["references"][0]["referenceId"] == "ts-agent-interface"
    assert index["hasMore"] and index["nextOffset"] == 1
    bundled = {item["referenceId"] for item in service.read({})["references"]}
    assert {"ts-device-plugin", "ts-plugin-sdk-api", "ts-plugin-streams"} <= bundled
    page = service.read({"referenceId": "ts-agent-interface", "limit": 1})
    assert page["lines"][0]["line"] == 1
    assert page["sources"][0]["contractRevision"] == "2026-09-16.2"
    assert service.read({"query": "get_tool_contract"})["total"] > 0
    assert service.read({"referenceId": "ts-agent-interface", "query": "mock"})["total"] == 0
    # No section holds every word: the sections holding most of them, best first.
    ranked = service.read({"referenceId": "ts-device-plugin", "query": "SerialPort zzzz-absent"})
    assert ranked["total"] > 0 and any("SerialPort" in row["text"] for row in ranked["lines"])


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
    "path", ["../outside.txt", "C:/Windows/system.ini", ".teststand/logs/x.txt", "x.pdf"]
)
def test_reference_import_is_confined_to_supported_user_files(tmp_path: Path, path: str) -> None:
    with pytest.raises(AppError):
        ReferenceService(str(tmp_path)).register(
            {"referenceId": "board", "title": "Board", "path": path}
        )


def test_bundled_id_cannot_be_overwritten(tmp_path: Path) -> None:
    with pytest.raises(AppError, match="referenceId"):
        ReferenceService(str(tmp_path)).register(
            {"referenceId": "ts-agent-interface", "title": "wrong", "path": "x.md"}
        )
