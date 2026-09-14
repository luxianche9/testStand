import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from hardwareharness_backend.compat import json_parse, json_stringify
from hardwareharness_backend.projects import ProjectService, migration, project_path
from hardwareharness_backend.storage import SettingsStore, atomic_json


async def service(root: Path) -> ProjectService:
    settings = SettingsStore(root / "settings.json")
    await settings.initialize()
    return ProjectService(settings)


def legacy(root: Path, version: int = 3) -> Path:
    path = Path(project_path(root))
    path.parent.mkdir(parents=True)
    path.write_text(
        json_stringify(
            {
                "formatVersion": version,
                "projectId": "existing",
                "name": "Existing",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "wiring": {"nodes": [], "connections": []},
                "task": {"uninterpreted": True},
            }
        ),
        encoding="utf-8",
    )
    logs = path.parent / "logs/runs/old"
    logs.mkdir(parents=True)
    (logs / "events.jsonl").write_bytes(b'{"old":true}\n')
    return path


@pytest.mark.parametrize("version", [1, 2, 3])
async def test_backup_before_v4_without_interpreting_task(tmp_path: Path, version: int) -> None:
    project = await service(tmp_path)
    path = legacy(tmp_path, version)
    original = path.read_bytes()
    assert (await project.inspect_folder(tmp_path))["state"] == "ready"
    assert path.read_bytes() == original
    opened = await project.open_folder(tmp_path)
    assert opened["file"]["formatVersion"] == 4
    assert "task" not in opened["file"]
    backups = list((path.parent / "backups").glob("legacy-*/project.json"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == original
    assert (backups[0].parent / "runs/old/events.jsonl").read_bytes() == b'{"old":true}\n'
    assert not (path.parent / "logs/runs").exists()
    current = path.read_bytes()
    await project.open_folder(tmp_path)
    assert path.read_bytes() == current
    assert len(list((path.parent / "backups").iterdir())) == 1


async def test_failed_commit_resumes_verified_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await service(tmp_path)
    path = legacy(tmp_path)
    original = path.read_bytes()
    write = atomic_json
    monkeypatch.setattr(migration, "atomic_json", AsyncMock(side_effect=OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        await project.open_folder(tmp_path)
    assert path.read_bytes() == original
    monkeypatch.setattr(migration, "atomic_json", write)
    await project.open_folder(tmp_path)
    assert json_parse(path.read_text("utf-8"))["formatVersion"] == 4
    assert len(list((path.parent / "backups").iterdir())) == 1


async def test_corrupted_backup_never_commits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await service(tmp_path)
    path = legacy(tmp_path)
    original = path.read_bytes()
    write = atomic_json
    monkeypatch.setattr(migration, "atomic_json", AsyncMock(side_effect=OSError("stop")))
    with pytest.raises(OSError):
        await project.open_folder(tmp_path)
    next((path.parent / "backups").glob("legacy-*/project.json")).write_bytes(b"damaged")
    monkeypatch.setattr(migration, "atomic_json", write)
    with pytest.raises(ValueError, match="backup"):
        await project.open_folder(tmp_path)
    assert path.read_bytes() == original


async def test_conversion_without_logs_and_v4_open_is_byte_preserving(tmp_path: Path) -> None:
    project = await service(tmp_path)
    created = await project.initialize_folder(tmp_path)
    path = Path(created["path"])
    path.write_text(json_stringify({**created["file"], "formatVersion": 2}), encoding="utf-8")
    await project.open_folder(tmp_path)
    raw = path.read_bytes()
    assert (await project.open_folder(tmp_path))["file"]["formatVersion"] == 4
    assert path.read_bytes() == raw


async def test_sealed_staging_recovers_after_rename_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await service(tmp_path)
    path = legacy(tmp_path)
    original = path.read_bytes()
    replace = os.replace

    def fail_rename(source: Path, target: Path) -> None:
        if str(source).endswith(".pending"):
            raise OSError("rename interrupted")
        replace(source, target)

    monkeypatch.setattr(os, "replace", fail_rename)
    with pytest.raises(OSError, match="interrupted"):
        await project.open_folder(tmp_path)
    assert path.read_bytes() == original
    monkeypatch.setattr(os, "replace", replace)
    await project.open_folder(tmp_path)
    assert len(list((path.parent / "backups").iterdir())) == 1


def test_backup_rejects_modified_live_logs_and_incomplete_state(tmp_path: Path) -> None:
    path = legacy(tmp_path)
    backup, runs = migration._prepare(path, path.read_bytes())
    (runs / "old/events.jsonl").write_bytes(b"changed")
    with pytest.raises(ValueError, match="changed after backup"):
        migration._prepare(path, path.read_bytes())
    (backup / "conversion.json").unlink()
    with pytest.raises(ValueError, match="Incomplete legacy backup"):
        migration._prepare(path, path.read_bytes())


def test_backup_rejects_symlink_before_writing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = legacy(tmp_path)
    original = path.read_bytes()
    original_is_symlink = Path.is_symlink
    monkeypatch.setattr(
        Path, "is_symlink", lambda target: target.name == "backups" or original_is_symlink(target)
    )
    (path.parent / "backups").mkdir()
    with pytest.raises(ValueError, match="cannot be links"):
        migration._prepare(path, original)
    assert path.read_bytes() == original


async def test_external_manifest_change_during_backup_is_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await service(tmp_path)
    path = legacy(tmp_path)
    prepare = migration._prepare
    external = b'{"user":"edited while backing up"}'

    def concurrent_edit(manifest: Path, original: bytes) -> tuple[Path, Path]:
        result = prepare(manifest, original)
        manifest.write_bytes(external)
        return result

    monkeypatch.setattr(migration, "_prepare", concurrent_edit)
    with pytest.raises(ValueError, match="changed during backup"):
        await project.open_folder(tmp_path)
    assert path.read_bytes() == external
