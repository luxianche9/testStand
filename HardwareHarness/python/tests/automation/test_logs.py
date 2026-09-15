from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.automation.logs import RunLogStore, atomic_json, redact, safe_child


def record() -> dict[str, Any]:
    return {"runId": "run_1", "status": "running", "startedAt": "2026-01-01", "eventCount": 0}


def test_utf8_redaction_and_pagination(tmp_path: Path) -> None:
    store = RunLogStore(tmp_path)
    run = record()
    store.save(run)
    for number in range(5):
        store.append(
            run, "log", {"text": "中文", "number": number, "fields": {"token": "never persist"}}
        )
    data = (store.path("run_1") / "events.jsonl").read_bytes()
    assert "中文".encode() in data
    assert b"never persist" not in data
    assert len(data.splitlines()) == 5
    assert [event["sequence"] for event in store.events("run_1", 2, 2)] == [3, 4]
    assert store.events("run_1", 10) == []
    assert redact([{"password": "secret"}]) == [{"password": "[REDACTED]"}]


@pytest.mark.parametrize("name", [".", "..", "../run", "a/b", ""])
def test_run_paths_reject_traversal(tmp_path: Path, name: str) -> None:
    store = RunLogStore(tmp_path)
    with pytest.raises(ValueError, match="Run"):
        store.delete(name)
    with pytest.raises(ValueError, match="workspace"):
        safe_child(tmp_path, "../outside")


def test_partial_tail_is_ignored_and_interior_damage_rejected(tmp_path: Path) -> None:
    store = RunLogStore(tmp_path)
    run = record()
    store.append(run, "log", {})
    journal = store.path("run_1") / "events.jsonl"
    with journal.open("ab") as stream:
        stream.write(b'{"partial":')
    assert len(store.events("run_1")) == 1
    with journal.open("ab") as stream:
        stream.write(b'\n{"more":true}\n')
    with pytest.raises(ValueError, match="Corrupt"):
        store.events("run_1")


def test_snapshot_skips_environment_and_generated_files(tmp_path: Path) -> None:
    workspace = tmp_path / ".hardwareharness"
    for name in [
        "scripts/main.py",
        "scripts/helper.py",
        "scripts/readme.txt",
        "uv.lock",
        ".venv/secret.txt",
        "logs/secret.txt",
        "artifacts/secret.txt",
    ]:
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("content", encoding="utf-8")
    store = RunLogStore(tmp_path)
    target, hashes = store.snapshot("run_1")
    assert set(hashes) == {"scripts/main.py", "scripts/helper.py", "uv.lock"}
    assert (target / "uv.lock").read_text() == "content"
    assert not (target / ".venv").exists()


def test_snapshot_rejects_symbolic_file_or_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    scripts = tmp_path / ".hardwareharness/scripts"
    scripts.mkdir(parents=True)
    (scripts / "link.py").write_text("pass", encoding="utf-8")
    original = Path.is_symlink

    def link(path: Path) -> bool:
        return path.name == "link.py" or original(path)

    monkeypatch.setattr(Path, "is_symlink", link)
    with pytest.raises(ValueError, match="outside"):
        RunLogStore(tmp_path).snapshot("run_1")
    (scripts / "link.py").unlink()
    (scripts / "link.py").mkdir()
    with pytest.raises(ValueError, match="symbolic"):
        RunLogStore(tmp_path).snapshot("run_1")


def test_attachment_copy_digest_and_delete(tmp_path: Path) -> None:
    source = tmp_path / "图像.txt"
    source.write_text("data", encoding="utf-8")
    store = RunLogStore(tmp_path)
    store.save(record())
    item = store.attachment("run_1", source, "../../friendly.txt")
    assert item["name"] == "friendly.txt"
    assert (tmp_path / item["path"]).read_text() == "data"
    assert item["size"] == 4
    with pytest.raises(ValueError, match="existing"):
        store.attachment("run_1", source / "absent")
    with pytest.raises(ValueError, match="name"):
        store.attachment("run_1", source, "..")
    store.delete("run_1")
    store.delete("run_1")
    assert not store.path("run_1").exists()


def test_atomic_write_retries_without_losing_previous_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "record.json"
    atomic_json(destination, {"value": "before"})
    original = Path.replace
    attempts = 0

    def fail_twice(path: Path, target: Any) -> Path:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError("file busy")
        return original(path, target)

    monkeypatch.setattr(Path, "replace", fail_twice)
    atomic_json(destination, {"value": "after"})
    assert attempts == 3
    assert json.loads(destination.read_text())["value"] == "after"

    def fail(path: Path, target: Any) -> Path:
        raise OSError("disk failure")

    monkeypatch.setattr(Path, "replace", fail)
    with pytest.raises(OSError, match="disk failure"):
        atomic_json(destination, {"value": "lost"})
    assert json.loads(destination.read_text())["value"] == "after"


def test_recovery_keeps_completed_and_live_runs(tmp_path: Path) -> None:
    store = RunLogStore(tmp_path)
    store.save(record())
    store.save({**record(), "runId": "run_2", "status": "succeeded"})
    store.recover({"run_1"})
    assert store.read("run_1")["status"] == "running"
    assert store.read("run_2")["status"] == "succeeded"
    assert store.events("run_2") == []


def test_recovery_repairs_truncated_tail_before_appending(tmp_path: Path) -> None:
    store = RunLogStore(tmp_path)
    run = record()
    store.append(run, "log", {"message": "saved"})
    journal = store.path("run_1") / "events.jsonl"
    with journal.open("ab") as stream:
        stream.write(b'{"partial":')
    store.recover(set())
    events = store.events("run_1")
    assert [event["sequence"] for event in events] == [1, 2]
    assert events[-1]["data"]["status"] == "interrupted"
    assert journal.with_suffix(".partial").read_bytes() == b'{"partial":'


def test_log_and_artifact_roots_cannot_resolve_outside_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunLogStore(tmp_path)
    original = Path.resolve
    outside = tmp_path.parent / "outside"

    def redirect(path: Path, *args: Any, **kwargs: Any) -> Path:
        return outside if path == store.directory else original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", redirect)
    with pytest.raises(ValueError, match="inside"):
        store.path("run_1")

    def redirect_artifacts(path: Path, *args: Any, **kwargs: Any) -> Path:
        return outside if path == store.artifacts else original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", redirect_artifacts)
    source = tmp_path / "file.txt"
    source.write_text("test", encoding="utf-8")
    with pytest.raises(ValueError, match="inside"):
        store.attachment("run_1", source)
