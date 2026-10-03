import asyncio
import errno
import os
from pathlib import Path
from typing import Any

import pytest

from teststand_backend.storage import (
    SettingsStore,
    atomic_json,
    atomic_text,
    read_json,
    sync_directory,
)
from teststand_backend.util import UNDEFINED, clone


@pytest.mark.ts_case(
    "packages/storage/src/storage.test.ts::file storage::"
    "atomically writes text and JSON and handles missing files"
)
@pytest.mark.asyncio
async def test_atomic_files(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "value.json"
    assert await read_json(path) is UNDEFINED
    await atomic_json(path, {"ready": True})
    await atomic_text(tmp_path / "value.txt", "payload")
    assert await read_json(path) == {"ready": True}
    assert path.read_bytes() == b'{\n  "ready": true\n}\n'
    assert (tmp_path / "value.txt").read_text() == "payload"
    path.write_text("{", encoding="utf-8")
    with pytest.raises(ValueError):
        await read_json(path)


@pytest.mark.ts_case(
    "packages/storage/src/storage.test.ts::SettingsStore::"
    "serializes concurrent writes so an older disk write cannot win"
)
@pytest.mark.asyncio
async def test_serialized_settings(tmp_path: Path) -> None:
    persisted: Any = None
    blocked = asyncio.Event()
    count = 0

    async def write(path: str | Path, value: Any) -> None:
        nonlocal count, persisted
        count += 1
        if count == 2:
            await blocked.wait()
        persisted = clone(value)

    store = SettingsStore(tmp_path / "settings.json", write)
    await store.initialize()
    first = asyncio.create_task(store.update({"theme": "dark"}))
    second = asyncio.create_task(store.update({"projectView": "logs"}))
    await asyncio.sleep(0)
    blocked.set()
    await asyncio.gather(first, second)
    assert store.get()["theme"] == persisted["theme"] == "dark"
    assert store.get()["projectView"] == persisted["projectView"] == "wiring"


@pytest.mark.asyncio
async def test_settings_defaults_strip_and_clone(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    await store.initialize()
    result = await store.update({"projectView": "retired-view", "extra": 2})
    assert result["projectView"] == "wiring"
    assert "extra" not in result
    result["llm"]["model"] = "mutated"
    assert store.get()["llm"]["model"] == "gpt-4.1"
    with pytest.raises(ValueError):
        await store.update({"theme": "unknown"})
    assert (await store.update({"theme": "dark"}))["theme"] == "dark"
    await store.flush()
    reloaded = SettingsStore(tmp_path / "settings.json")
    await reloaded.initialize()
    assert reloaded.get()["theme"] == "dark"


@pytest.mark.asyncio
async def test_atomic_failure_cleanup_and_sync_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "value.txt"
    await atomic_text(path, "before")
    await sync_directory(path)

    def failed_replace(source: str | Path, target: str | Path) -> None:
        raise OSError(errno.EIO, "replace failure")

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", failed_replace)
        with pytest.raises(OSError, match="replace failure"):
            await atomic_text(path, "after")
    assert path.read_text() == "before"
    assert list(tmp_path.glob("*.tmp")) == []

    def failed_open(path: str | Path, flags: int) -> int:
        raise OSError(errno.EIO, "sync failure")

    with monkeypatch.context() as patch:
        patch.setattr(os, "open", failed_open)
        with pytest.raises(OSError, match="sync failure"):
            await sync_directory(tmp_path)
