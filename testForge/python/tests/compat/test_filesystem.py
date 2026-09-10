import json
import os
from collections.abc import Callable
from pathlib import Path

import pytest

from testforge_backend.compat import Record
from testforge_backend.compat.filesystem import (
    NodeFsError,
    NodePathError,
    fs_operation,
    mkdir,
    read_bytes,
    replace,
    rm,
    scandir,
    stat,
    unlink,
    validate_path,
)

CASES: list[Record] = json.loads(Path(__file__).with_name("fs-golden.json").read_text("utf-8"))


@pytest.mark.skipif(os.name != "nt", reason="Original Electron Windows filesystem golden")
@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_electron_filesystem_error_golden(tmp_path: Path, case: Record) -> None:
    (tmp_path / "file").write_text("data")
    (tmp_path / "directory").mkdir()
    (tmp_path / "readonly").write_text("data")
    (tmp_path / "readonly").chmod(0o444)

    def open_existing() -> None:
        with fs_operation("open", tmp_path / "file"), (tmp_path / "file").open("xb"):
            pass

    operations: dict[str, Callable[[], object]] = {
        "stat-missing": lambda: stat(tmp_path / "missing"),
        "read-missing": lambda: read_bytes(tmp_path / "missing"),
        "read-directory": lambda: read_bytes(tmp_path / "directory"),
        "read-parent-file": lambda: read_bytes(tmp_path / "file/child"),
        "stat-parent-file": lambda: stat(tmp_path / "file/child"),
        "mkdir-parent-file": lambda: mkdir(tmp_path / "file/child"),
        "mkdir-existing-file": lambda: mkdir(tmp_path / "file"),
        "scandir-file": lambda: scandir(tmp_path / "file"),
        "rename-missing": lambda: replace(tmp_path / "missing", tmp_path / "target"),
        "rename-to-directory": lambda: replace(tmp_path / "file", tmp_path / "directory"),
        "open-existing": open_existing,
        "unlink-directory": lambda: unlink(tmp_path / "directory"),
        "rm-directory": lambda: rm(tmp_path / "directory", force=True),
        "rm-readonly": lambda: rm(tmp_path / "readonly", force=True),
        "rm-missing": lambda: rm(tmp_path / "missing", force=True),
    }
    if "result" in case:
        operations[case["name"]]()
        assert case["result"] == "success"
        return
    with pytest.raises(NodeFsError) as caught:
        operations[case["name"]]()
    error = caught.value
    assert {
        "name": case["name"],
        "message": str(error).replace(str(tmp_path), "<ROOT>"),
        "code": error.code,
        "syscall": error.syscall,
    } == case


def test_null_path_message_and_successful_operations(tmp_path: Path) -> None:
    with pytest.raises(NodePathError) as caught:
        validate_path("C:\\project\\a\0b")
    assert str(caught.value) == (
        "The argument 'path' must be a string, Uint8Array, or URL without null bytes. "
        "Received 'C:\\\\project\\\\a\\x00b'"
    )
    folder = tmp_path / "nested"
    mkdir(folder)
    mkdir(folder)
    original = folder / "original"
    original.write_bytes(b"data")
    assert read_bytes(original) == b"data"
    assert stat(original).st_size == 4
    renamed = folder / "renamed"
    replace(original, renamed)
    assert scandir(folder) == [renamed]
    unlink(renamed)
    unlink(renamed, missing_ok=True)


def test_recursive_remove_readonly_and_missing_error(tmp_path: Path) -> None:
    folder = tmp_path / "readonly-run"
    folder.mkdir()
    (folder / "run.jsonl").write_text("logged")
    (folder / "run.jsonl").chmod(0o444)
    rm(folder, recursive=True, force=True)
    assert not folder.exists()
    with pytest.raises(FileNotFoundError) as caught:
        rm(folder)
    assert str(caught.value) == f"ENOENT: no such file or directory, lstat '{folder}'"
