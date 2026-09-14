from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.workspace.files import WorkspaceService


def test_files_are_relative_to_hidden_workspace_and_preserve_user_files(tmp_path: Path) -> None:
    service = WorkspaceService(str(tmp_path))
    service.create("workflows", "directory")
    created = service.create("workflows/中文 script.py", "file", "print('hello')\n")
    assert created["hash"] == service.read("workflows/中文 script.py")["hash"]
    assert service.tree() == [
        {"path": "workflows", "name": "workflows", "kind": "directory"},
        {"path": "workflows/中文 script.py", "name": "中文 script.py", "kind": "file"},
    ]
    with pytest.raises(AppError, match="already exists"):
        service.create("workflows/中文 script.py", "file", "replacement")
    assert service.read("workflows/中文 script.py")["content"] == "print('hello')\n"


@pytest.mark.parametrize(
    "path",
    [
        "../outside.py",
        "/absolute.py",
        "C:/absolute.py",
        "a/../../b",
        "a\\..\\b",
        "a:stream",
        "",
        "CON",
        "a./file",
        "a /file",
        "NUL.py",
    ],
)
def test_paths_cannot_escape_workspace(tmp_path: Path, path: str) -> None:
    with pytest.raises(AppError):
        WorkspaceService(str(tmp_path)).create(path, "file")


@pytest.mark.parametrize(
    "path",
    ["project.json", ".venv/x", "logs/x", "artifacts/x", "uv.lock", "Logs/x", "PROJECT.JSON"],
)
def test_platform_owned_paths_are_readonly(tmp_path: Path, path: str) -> None:
    with pytest.raises(AppError, match="platform"):
        WorkspaceService(str(tmp_path)).create(path, "file")


def test_save_detects_external_edits_and_writes_exact_utf8(tmp_path: Path) -> None:
    service = WorkspaceService(str(tmp_path))
    first = service.create("a.py", "file", "old\r\n")
    path = tmp_path / ".hardwareharness/a.py"
    path.write_bytes(b"agent edit\n")
    with pytest.raises(AppError) as conflict:
        service.write("a.py", "human edit\n", first["hash"])
    assert conflict.value.category == "conflict"
    updated = service.write("a.py", "中文\n", service.read("a.py")["hash"])
    assert path.read_bytes() == "中文\n".encode()
    assert updated["content"] == "中文\n"


def test_rename_delete_search_and_snapshot(tmp_path: Path) -> None:
    service = WorkspaceService(str(tmp_path))
    service.create("a.py", "file", "one\ntwo one\n")
    before = service.snapshot()
    service.rename("a.py", "workflows/b.py")
    assert service.search("one") == [
        {"path": "workflows/b.py", "line": 1, "column": 1, "text": "one"},
        {"path": "workflows/b.py", "line": 2, "column": 5, "text": "two one"},
    ]
    assert service.snapshot() != before
    service.delete("workflows")
    assert service.tree() == []


def test_generated_files_hidden_and_binary_not_opened(tmp_path: Path) -> None:
    root = tmp_path / ".hardwareharness"
    (root / "logs").mkdir(parents=True)
    (root / "logs/secret.json").write_text("{}")
    (root / "picture.png").write_bytes(b"\x89PNG\x00")
    service = WorkspaceService(str(tmp_path))
    assert [item["path"] for item in service.tree()] == ["picture.png"]
    assert service.search("PNG") == []
    with pytest.raises(AppError, match="UTF-8"):
        service.read("picture.png")


def test_python_syntax_diagnostics_do_not_write_unsaved_buffer(tmp_path: Path) -> None:
    service = WorkspaceService(str(tmp_path))
    service.create("a.py", "file", "print(1)\n")
    diagnostics = service.syntax_diagnostics("a.py", "def broken(:\n")
    assert diagnostics[0]["code"] == "syntax"
    assert diagnostics[0]["line"] == 1
    assert service.read("a.py")["content"] == "print(1)\n"
    assert service.syntax_diagnostics("a.js", "def broken(:\n") == []


def test_symlink_target_outside_workspace_is_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / ".hardwareharness"
    root.mkdir()
    try:
        (root / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        assert os.name == "nt"
        subprocess.run(
            ["cmd", "/d", "/c", "mklink", "/J", str(root / "linked"), str(outside)],
            check=True,
            capture_output=True,
        )
    with pytest.raises(AppError):
        WorkspaceService(str(tmp_path)).create("linked/a.py", "file")
    assert WorkspaceService(str(tmp_path)).tree() == []


def test_file_errors_do_not_modify_existing_paths(tmp_path: Path) -> None:
    service = WorkspaceService(str(tmp_path))
    assert service.tree() == [] and service.search("") == []
    service.create("a", "directory")
    service.create("b", "directory")
    for action in (
        lambda: service.read("missing"),
        lambda: service.rename("missing", "next"),
        lambda: service.rename("a", "b"),
        lambda: service.rename("a", "a/child"),
        lambda: service.delete("missing"),
        lambda: service.create("other", "unsupported"),
        lambda: service.create("nul.txt", "file", "\x00"),
        lambda: service.create("big.txt", "file", "x" * (4 * 1024 * 1024 + 1)),
    ):
        with pytest.raises(AppError):
            action()
    binary = tmp_path / ".hardwareharness/binary.txt"
    binary.write_bytes(b"hello\x00world")
    with pytest.raises(AppError, match="UTF-8"):
        service.read("binary.txt")
    binary.write_bytes(b"x" * (4 * 1024 * 1024 + 1))
    with pytest.raises(AppError, match="4 MiB"):
        service.read("binary.txt")
    service.delete("binary.txt")
    assert not binary.exists()
    service.create("all.py", "file", "match\n" * 1200)
    assert len(service.search("match")) == 1000


async def test_python_diagnostics_use_unsaved_content_and_ruff(tmp_path: Path) -> None:
    service = WorkspaceService(str(tmp_path))
    service.create("a.py", "file", "print(1)\n")
    assert service.syntax_diagnostics("a.py") == []
    assert await service.diagnose("a.py", "bad (: ", python=sys.executable)
    diagnostics = await service.diagnose("a.py", "import os\n", python=sys.executable)
    assert any(item["code"] == "F401" for item in diagnostics)
    assert await service.diagnose("a.py", python=sys.executable) == []
    assert await service.diagnose("a.py") == []
