import asyncio
import errno
import os
from pathlib import Path
from typing import Any, cast

import pytest

from hardwareharness_backend.storage import (
    SecretStore,
    SettingsStore,
    atomic_json,
    atomic_text,
    read_json,
    sync_directory,
)
from hardwareharness_backend.util import UNDEFINED, clone


class Protector:
    def encrypt(self, value: str) -> bytes:
        return value.encode("utf-8")

    def decrypt(self, value: bytes) -> str:
        return value.decode("utf-8")


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


@pytest.mark.ts_case(
    "packages/storage/src/storage.test.ts::SecretStore::"
    "stores, retrieves, removes, and creates stable tokens"
)
@pytest.mark.asyncio
async def test_secrets(tmp_path: Path) -> None:
    store = SecretStore(tmp_path / "secrets.json", Protector())
    await store.initialize()
    await store.set("api", {"key": "secret"})
    assert store.has("api")
    assert store.get("api") == {"key": "secret"}
    first, second = await asyncio.gather(
        store.ensure_token("gateway"), store.ensure_token("gateway")
    )
    assert first == second
    assert len(first) == 43
    await store.remove("api")
    assert not store.has("api")
    assert (await read_json(tmp_path / "secrets.json"))["entries"]["gateway"]
    with pytest.raises(RuntimeError, match="Secret not found"):
        store.get("missing")


@pytest.mark.ts_case(
    "apps/desktop/src/main/migrations.test.ts::global file storage::"
    "keeps committed state intact after a failed secret write and accepts the next write"
)
@pytest.mark.asyncio
async def test_failed_secret_write_does_not_poison_queue(tmp_path: Path) -> None:
    fail = False

    async def write(path: str | Path, value: Any) -> None:
        nonlocal fail
        if fail:
            fail = False
            raise RuntimeError("simulated write failure")
        await atomic_json(path, value)

    store = SecretStore(tmp_path / "secrets.json", Protector(), write)
    await store.initialize()
    await store.set("stable", {"value": 1})
    fail = True
    with pytest.raises(RuntimeError, match="simulated write failure"):
        await store.set("failed", {"value": 2})
    assert not store.has("failed")
    assert store.get("stable") == {"value": 1}
    await store.set("recovered", {"value": 3})
    assert store.get("recovered") == {"value": 3}


@pytest.mark.asyncio
async def test_secret_decryption_stays_lazy(tmp_path: Path) -> None:
    class BrokenProtector(Protector):
        def decrypt(self, value: bytes) -> str:
            raise RuntimeError("bad ciphertext")

    path = tmp_path / "secrets.json"
    await atomic_json(path, {"formatVersion": 1, "entries": {"broken": "YQ=="}})
    store = SecretStore(path, BrokenProtector())
    await store.initialize()
    assert store.has("broken")
    with pytest.raises(RuntimeError, match="bad ciphertext"):
        store.get("broken")


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


@pytest.mark.asyncio
async def test_secret_reopen_remove_absent_and_flush(tmp_path: Path) -> None:
    path = tmp_path / "secrets.json"
    store = SecretStore(path, Protector())
    await store.initialize()
    await store.set("nested", {"list": [1]})
    await store.flush()
    reopened = SecretStore(path, Protector())
    await reopened.initialize()
    value = reopened.get("nested")
    value["list"].append(2)
    assert reopened.get("nested") == {"list": [1]}
    before = path.read_bytes()
    await reopened.remove("absent")
    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_secret_undefined_and_primitive_token_match_javascript(tmp_path: Path) -> None:
    received: list[Any] = []

    class BoundaryProtector(Protector):
        def encrypt(self, value: str) -> bytes:
            received.append(value)
            return b"null" if cast(object, value) is UNDEFINED else super().encrypt(value)

    store = SecretStore(tmp_path / "secrets.json", BoundaryProtector())
    await store.initialize()
    await store.set("undefined", UNDEFINED)
    assert received == [UNDEFINED]
    assert store.get("undefined") is None
    await store.set("primitive", 1)
    assert cast(object, await store.ensure_token("primitive")) is UNDEFINED
    with pytest.raises(TypeError, match="Cannot read properties of null"):
        await store.ensure_token("undefined")


@pytest.mark.parametrize(
    ("encoded", "expected"),
    [
        ("YQ", b"a"),
        ("YQx", b"a\x0c"),
        ("YQxxx", b"a\x0cq"),
        ("YQ===garbage", b"a"),
        ("Y Q\n", b"a"),
        ("-_8", b"\xfb\xff"),
        ("a", b""),
    ],
)
@pytest.mark.asyncio
async def test_secret_base64_uses_node_buffer_rules(
    tmp_path: Path, encoded: str, expected: bytes
) -> None:
    received: list[bytes] = []

    class BinaryProtector(Protector):
        def decrypt(self, value: bytes) -> str:
            received.append(value)
            return "{}"

    path = tmp_path / "secrets.json"
    await atomic_json(path, {"formatVersion": 1, "entries": {"entry": encoded}})
    store = SecretStore(path, BinaryProtector())
    await store.initialize()
    assert store.get("entry") == {}
    assert received == [expected]
