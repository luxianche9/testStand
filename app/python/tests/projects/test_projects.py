from pathlib import Path
from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.projects import ProjectService, project_display_name, project_path
from teststand_backend.storage import SettingsStore
from teststand_backend.util import json_dumps, json_loads

PREFIX = "packages/projects/src/project-service.test.ts::ProjectService folder projects::"
CONNECTION = {
    "connectionId": "C",
    "portA": "A.J1",
    "portB": "B.J1",
    "pins": [],
    "confirmedAt": "2026-09-15T00:00:00.000Z",
    "confirmedBy": "user",
}


def channel(stream_id: str = "ai0") -> dict[str, Any]:
    return {"hardwareId": "A", "streamId": stream_id}


async def fixture(root: Path) -> tuple[ProjectService, SettingsStore]:
    settings = SettingsStore(root / "settings.json")
    await settings.initialize()
    service = ProjectService(settings)
    await service.initialize()
    return service, settings


@pytest.mark.ts_case(
    PREFIX + "starts without an active project and reports requires_project for project operations"
)
@pytest.mark.asyncio
async def test_no_project(tmp_path: Path) -> None:
    service, _ = await fixture(tmp_path)
    assert service.current() is None
    with pytest.raises(AppError) as error:
        service.wiring()
    assert error.value.category == "requires_project"
    with pytest.raises(AppError) as error:
        await service.save()
    assert error.value.category == "requires_project"


@pytest.mark.ts_case(PREFIX + "initializes and opens the fixed .testforge/project.json manifest")
@pytest.mark.asyncio
async def test_folder_lifecycle(tmp_path: Path) -> None:
    service, _ = await fixture(tmp_path)
    folder = tmp_path / "bench-a"
    folder.mkdir()
    assert (await service.inspect_folder(folder))["state"] == "uninitialized"
    created = await service.initialize_folder(folder)
    assert created["rootPath"] == str(folder)
    assert created["path"] == project_path(folder)
    assert created["file"]["name"] == "bench-a"
    await service.leave()
    assert service.current() is None
    assert (await service.open_folder(folder))["dirty"] is False


@pytest.mark.ts_case(PREFIX + "saves atomically and never overwrites a damaged manifest")
@pytest.mark.asyncio
async def test_save_damage(tmp_path: Path) -> None:
    service, _ = await fixture(tmp_path)
    folder = tmp_path / "bench-b"
    folder.mkdir()
    await service.initialize_folder(folder)
    service.update_monitor({"channels": [channel()]})
    await service.save()
    assert len(json_loads(Path(project_path(folder)).read_text())["monitor"]["channels"]) == 1
    await service.leave()
    Path(project_path(folder)).write_text("{ broken")
    assert (await service.inspect_folder(folder))["state"] == "invalid"
    with pytest.raises(AppError) as error:
        await service.initialize_folder(folder)
    assert error.value.category == "invalid_project"
    assert Path(project_path(folder)).read_text() == "{ broken"


@pytest.mark.ts_case(PREFIX + "rejects future manifest versions without modifying them")
@pytest.mark.asyncio
async def test_future(tmp_path: Path) -> None:
    service, _ = await fixture(tmp_path)
    folder = tmp_path / "future"
    path = Path(project_path(folder))
    path.parent.mkdir(parents=True)
    raw = json_dumps({"formatVersion": 99, "projectId": "FUTURE"})
    path.write_text(raw)
    assert (await service.inspect_folder(folder))["state"] == "invalid"
    with pytest.raises(AppError) as error:
        await service.open_folder(folder)
    assert error.value.category == "invalid_project"
    assert path.read_text() == raw


@pytest.mark.ts_case(
    PREFIX + "keeps all recent projects newest-first, deduplicates canonical paths, "
    "and preserves broken entries"
)
@pytest.mark.asyncio
async def test_recent(tmp_path: Path) -> None:
    service, settings = await fixture(tmp_path)
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    await service.initialize_folder(first)
    service.update_wiring({"connections": [CONNECTION]})
    service.update_monitor({"channels": [channel("ai0"), channel("ai1")]})
    await service.save()
    await service.initialize_folder(second)
    await service.open_folder(first)
    assert [item["rootPath"] for item in settings.get()["recentProjects"]] == [
        str(first),
        str(second),
    ]
    Path(project_path(second)).rename(project_path(second) + ".broken")
    recent = await service.list_recent()
    assert recent[0]["status"] == "available"
    assert recent[0]["preview"] == {"connections": 1, "channels": 2}
    assert recent[1]["status"] == "invalid"
    await service.forget_recent(second)
    assert [item["rootPath"] for item in await service.list_recent()] == [str(first)]


@pytest.mark.asyncio
async def test_open_current_bytes_and_explicit_save(tmp_path: Path) -> None:
    service, _ = await fixture(tmp_path)
    created = await service.initialize_folder(tmp_path)
    assert created["file"]["formatVersion"] == 6 and "task" not in created["file"]
    path = Path(created["path"])
    raw = json_dumps({**created["file"], "ignored": True})
    path.write_text(raw, encoding="utf-8")
    opened = await service.open_folder(tmp_path)
    assert "ignored" not in opened["file"]
    assert path.read_text(encoding="utf-8") == raw
    opened["file"]["monitor"]["channels"].append(channel("outside"))
    assert service.monitor()["channels"] == []
    service.update_monitor({"channels": [channel()]})
    await service.close()
    await service.leave()
    assert path.read_text(encoding="utf-8") == raw
    assert (await service.open_folder(tmp_path))["file"]["monitor"]["channels"] == []


@pytest.mark.asyncio
async def test_identity_folder_errors_and_recent_fallbacks(tmp_path: Path) -> None:
    service, settings = await fixture(tmp_path)
    assert service.session() is None
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(AppError) as error:
        await service.open_folder(plain)
    assert error.value.category == "project_uninitialized"
    created = await service.initialize_folder(plain)
    assert service.current() == created
    assert service.project_id() == created["file"]["projectId"]
    assert service.session() == {"projectId": created["file"]["projectId"], "rootPath": str(plain)}
    assert project_display_name(created) == "plain"
    assert project_display_name({**created, "file": {**created["file"], "name": ""}}) == "plain"
    with pytest.raises(AppError) as error:
        await service.initialize_folder(plain)
    assert error.value.category == "project_exists"
    file = tmp_path / "ordinary.txt"
    file.write_text("text")
    with pytest.raises(AppError) as error:
        await service.inspect_folder(file)
    assert error.value.category == "invalid_project_folder"
    with pytest.raises(FileNotFoundError):
        await service.inspect_folder(tmp_path / "absent")
    Path(project_path(plain)).write_text("{ broken")
    await settings.update(
        {
            "recentProjects": [
                {"rootPath": str(root), "name": "saved-name", "openedAt": "2026-01-01T00:00:00Z"}
                for root in (plain, file, tmp_path / "absent")
            ]
        }
    )
    recent = await service.list_recent()
    assert [item["status"] for item in recent] == ["invalid", "missing", "missing"]
    assert recent[1]["message"] == "project_folder_missing"
    assert all(item["name"] == "saved-name" for item in recent)


@pytest.mark.asyncio
async def test_realpath_failure_keeps_resolved_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    service, _ = await fixture(tmp_path)

    def failed_realpath(path: str, *, strict: bool = False) -> str:
        raise OSError("cannot resolve")

    monkeypatch.setattr(os.path, "realpath", failed_realpath)
    assert (await service.inspect_folder(tmp_path))["rootPath"] == str(tmp_path)


@pytest.mark.asyncio
async def test_project_filesystem_errors_are_reported(tmp_path: Path) -> None:
    service, settings = await fixture(tmp_path)
    missing = tmp_path / "missing"
    with pytest.raises(FileNotFoundError):
        await service.inspect_folder(missing)
    await settings.update(
        {
            "recentProjects": [
                {"rootPath": str(missing), "name": "Missing", "openedAt": "2026-01-01T00:00:00Z"}
            ]
        }
    )
    assert (await service.list_recent())[0]["status"] == "missing"
    manifest_directory = tmp_path / ".teststand/project.json"
    manifest_directory.mkdir(parents=True)
    selection = await service.inspect_folder(tmp_path)
    assert selection["state"] == "invalid"
    with pytest.raises(AppError) as invalid:
        await service.open_folder(tmp_path)
    assert invalid.value.category == "invalid_project"
    assert str(invalid.value) == selection["message"]


@pytest.mark.asyncio
async def test_project_directory_occupied_by_file_is_rejected(tmp_path: Path) -> None:
    service, _ = await fixture(tmp_path)
    (tmp_path / ".teststand").write_text("a file")
    assert (await service.inspect_folder(tmp_path))["state"] == "uninitialized"
    with pytest.raises(OSError):
        await service.initialize_folder(tmp_path)


async def test_earlier_format_is_refused_by_name(tmp_path: Path) -> None:
    service, _ = await fixture(tmp_path)
    path = Path(project_path(tmp_path))
    path.parent.mkdir(parents=True)
    raw = json_dumps({"formatVersion": 5, "projectId": "OLD"})
    path.write_text(raw)
    selection = await service.inspect_folder(tmp_path)
    assert selection["state"] == "invalid" and "格式版本 5" in selection["message"]
    assert path.read_text() == raw
