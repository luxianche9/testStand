from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.workspace.files import MAX_FILE_BYTES
from teststand_backend.workspace.references import ReferenceService


def registry_path(root: Path) -> Path:
    path = root / ".teststand/docs/references/index.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def register_board(root: Path) -> tuple[ReferenceService, dict[str, Any], Path]:
    (root / "board.md").write_text("# Board\nPin 1 is ground.\n", encoding="utf-8")
    service = ReferenceService(str(root))
    entry = service.register({"referenceId": "board", "title": "Board", "path": "board.md"})
    saved = root / ".teststand/docs/references" / f"{entry['sha256']}.txt"
    return service, entry, saved


@pytest.mark.parametrize("raw", [b"{", b"\xff", b"[]", b'"wrong shape"', b"null"])
def test_corrupt_registry_is_a_structured_error_and_is_not_replaced(
    tmp_path: Path, raw: bytes
) -> None:
    index = registry_path(tmp_path)
    index.write_bytes(raw)
    service = ReferenceService(str(tmp_path))
    with pytest.raises(AppError, match="registry is invalid") as caught:
        service.read({})
    assert caught.value.category == "invalid_argument"
    assert index.read_bytes() == raw


def test_oversize_registry_is_rejected_before_loading_json(tmp_path: Path) -> None:
    index = registry_path(tmp_path)
    with index.open("wb") as stream:
        stream.truncate(MAX_FILE_BYTES + 1)
    with pytest.raises(AppError, match="registry exceeds") as caught:
        ReferenceService(str(tmp_path)).index()
    assert caught.value.category == "invalid_argument"
    assert index.stat().st_size == MAX_FILE_BYTES + 1


@pytest.mark.parametrize("entry", [None, "not a record", 5, []])
def test_registry_entry_must_be_a_record(tmp_path: Path, entry: object) -> None:
    registry_path(tmp_path).write_text(json.dumps({"board": entry}), encoding="utf-8")
    with pytest.raises(AppError, match="Unknown referenceId") as caught:
        ReferenceService(str(tmp_path)).read({"referenceId": "board"})
    assert caught.value.category == "not_found"


@pytest.mark.parametrize("digest", [None, 5, "", "0" * 63, "A" * 64, "../outside"])
def test_registry_hash_cannot_redirect_document_access(tmp_path: Path, digest: object) -> None:
    registry_path(tmp_path).write_text(json.dumps({"board": {"sha256": digest}}), encoding="utf-8")
    with pytest.raises(AppError, match="invalid content hash") as caught:
        ReferenceService(str(tmp_path)).read({"referenceId": "board"})
    assert caught.value.category == "invalid_argument"


def test_registry_cannot_create_an_escaped_reference_identifier(tmp_path: Path) -> None:
    registry_path(tmp_path).write_text(
        json.dumps({"../outside": {"sha256": "0" * 64}}), encoding="utf-8"
    )
    with pytest.raises(AppError, match="Unknown referenceId") as caught:
        ReferenceService(str(tmp_path)).read({"referenceId": "../outside"})
    assert caught.value.category == "not_found"


@pytest.mark.parametrize("damage", ["missing", "invalid_utf8", "tampered", "oversize"])
def test_registered_evidence_cannot_silently_become_missing_or_different(
    tmp_path: Path, damage: str
) -> None:
    service, entry, saved = register_board(tmp_path)
    original_registry = registry_path(tmp_path).read_bytes()
    if damage == "missing":
        saved.unlink()
        category, message = "unavailable", "cannot be read"
    elif damage == "invalid_utf8":
        saved.write_bytes(b"\xff")
        category, message = "unavailable", "cannot be read"
    elif damage == "tampered":
        saved.write_text("Pin 1 is an output.", encoding="utf-8")
        category, message = "conflict", "reference changed"
    else:
        with saved.open("wb") as stream:
            stream.truncate(MAX_FILE_BYTES + 1)
        category, message = "invalid_argument", "exceeds 4 MiB"
    with pytest.raises(AppError, match=message) as caught:
        service.read({"referenceId": entry["referenceId"]})
    assert caught.value.category == category
    assert registry_path(tmp_path).read_bytes() == original_registry


@pytest.mark.parametrize("reference_id", ["ts-agent-interface", "", "../board", "_board", "x" * 81])
def test_reserved_and_malformed_ids_fail_without_creating_registry(
    tmp_path: Path, reference_id: str
) -> None:
    with pytest.raises(AppError, match="referenceId") as caught:
        ReferenceService(str(tmp_path)).register(
            {"referenceId": reference_id, "title": "Board", "path": "board.md"}
        )
    assert caught.value.category == "invalid_argument"
    assert not (tmp_path / ".teststand").exists()


def test_register_requires_an_open_project() -> None:
    with pytest.raises(AppError, match="Open a project") as caught:
        ReferenceService().register({"referenceId": "board", "title": "Board", "path": "board.md"})
    assert caught.value.category == "requires_project"


@pytest.mark.parametrize(
    "kind", ["missing", "directory", "pdf", "invalid_utf8", "binary_nul", "oversize"]
)
def test_bad_source_is_rejected_without_publishing_an_entry(tmp_path: Path, kind: str) -> None:
    path = tmp_path / ("board.pdf" if kind == "pdf" else "board.txt")
    if kind == "directory":
        path.mkdir()
    elif kind in {"pdf", "invalid_utf8", "binary_nul"}:
        path.write_bytes(
            {"pdf": b"%PDF-1.7", "invalid_utf8": b"\xff", "binary_nul": b"a\x00b"}[kind]
        )
    elif kind == "oversize":
        with path.open("wb") as stream:
            stream.truncate(MAX_FILE_BYTES + 1)
    with pytest.raises(AppError) as caught:
        ReferenceService(str(tmp_path)).register(
            {"referenceId": "board", "title": "Board", "path": path.name}
        )
    expected = "not_found" if kind in {"missing", "directory"} else "invalid_argument"
    assert caught.value.category == expected
    assert not (tmp_path / ".teststand/docs/references/index.json").exists()
    if kind == "pdf":
        assert "Export" in caught.value.details["recovery"]


def link_directory(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            raise
        # Directory junction creation does not require Windows symlink privilege.
        subprocess.run(
            ["cmd", "/d", "/c", "mklink", "/J", str(link), str(target)],
            check=True,
            capture_output=True,
        )


@pytest.mark.parametrize("destination", ["outside_project", "managed_logs"])
def test_source_links_cannot_escape_or_alias_managed_evidence(
    tmp_path: Path, destination: str
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    target = (
        tmp_path / "outside" if destination == "outside_project" else project / ".teststand/logs"
    )
    target.mkdir(parents=True)
    document = target / "board.txt"
    document.write_text("protected evidence", encoding="utf-8")
    link_directory(project / "public-docs", target)
    with pytest.raises(AppError) as caught:
        ReferenceService(str(project)).register(
            {"referenceId": "board", "title": "Board", "path": "public-docs/board.txt"}
        )
    assert caught.value.category == "permission_denied"
    assert document.read_text("utf-8") == "protected evidence"
    assert not (project / ".teststand/docs/references/index.json").exists()


def test_stale_expected_hash_cannot_recreate_a_deleted_registration(tmp_path: Path) -> None:
    service, entry, _ = register_board(tmp_path)
    index = registry_path(tmp_path)
    index.write_text("{}", encoding="utf-8")
    with pytest.raises(AppError, match="no longer exists") as caught:
        service.register(
            {
                "referenceId": "board",
                "title": "Board",
                "path": "board.md",
                "expectedHash": entry["sha256"],
            }
        )
    assert caught.value.category == "conflict"
    assert json.loads(index.read_text("utf-8")) == {}


def test_hardware_reference_metadata_survives_search_without_exposing_full_text(
    tmp_path: Path,
) -> None:
    data = "# Board\n\nConnector J1 uses GROUND.\n"
    (tmp_path / "board.MD").write_bytes(data.encode("utf-8"))
    service = ReferenceService(str(tmp_path))
    entry = service.register(
        {"referenceId": "board", "title": "Board", "path": "board.MD", "hardwareId": "DUT_1"}
    )
    assert entry["sha256"] == hashlib.sha256(data.encode()).hexdigest()
    index = service.index()
    assert next(item for item in index if item["referenceId"] == "board")["hardwareId"] == "DUT_1"
    assert all("content" not in item for item in index)
    search = service.read({"query": "connector j1 uses ground"})
    assert search["lines"] == [
        {"referenceId": "board", "line": 1, "column": 1, "text": "# Board"},
        {"referenceId": "board", "line": 3, "column": 1, "text": "Connector J1 uses GROUND."},
    ]
    assert any(source.get("hardwareId") == "DUT_1" for source in search["sources"])
    blank = service.read({"referenceId": "board", "offset": 1, "limit": 1})
    assert blank["lines"][0]["text"] == ""
    assert service.read({"referenceId": "board", "query": "not present"})["total"] == 0


def test_reference_search_finds_words_spread_over_a_section(tmp_path: Path) -> None:
    data = "# Steps\n\nInvokeTool needs hardwareId.\nArguments sit on the step.\n# Other\nstep\n"
    (tmp_path / "plan.md").write_bytes(data.encode("utf-8"))
    service = ReferenceService(str(tmp_path))
    service.register({"referenceId": "plan", "title": "Plan", "path": "plan.md"})
    found = service.read({"referenceId": "plan", "query": "invoketool arguments step"})
    assert [row["line"] for row in found["lines"]] == [1, 3, 4]
