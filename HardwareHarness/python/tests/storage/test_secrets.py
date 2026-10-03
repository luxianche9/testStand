"""SecretStore over a credential-store backend (design doc §4.7)."""

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import pytest

from hardwareharness_backend.storage import SecretStore, atomic_json, read_json
from hardwareharness_backend.storage.secrets import (
    CHUNK,
    INDEX_FILE,
    SERVICE,
    FileSecretBackend,
    MemorySecretBackend,
)
from hardwareharness_backend.util import UNDEFINED


@pytest.mark.ts_case(
    "packages/storage/src/storage.test.ts::SecretStore::"
    "stores, retrieves, removes, and creates stable tokens"
)
async def test_secrets(tmp_path: Path) -> None:
    backend = MemorySecretBackend()
    store = SecretStore(tmp_path, backend)
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
    assert (SERVICE, "api") not in backend.values
    index = await read_json(tmp_path / INDEX_FILE)
    assert index["keys"] == ["gateway"]
    assert first not in (tmp_path / INDEX_FILE).read_text("utf-8")  # Names only, never values.
    with pytest.raises(RuntimeError, match="Secret not found"):
        store.get("missing")


@pytest.mark.ts_case(
    "apps/desktop/src/main/migrations.test.ts::global file storage::"
    "keeps committed state intact after a failed secret write and accepts the next write"
)
async def test_failed_index_write_does_not_poison_queue(tmp_path: Path) -> None:
    fail = False

    async def write(path: str | Path, value: Any) -> None:
        nonlocal fail
        if fail:
            fail = False
            raise RuntimeError("simulated write failure")
        await atomic_json(path, value)

    store = SecretStore(tmp_path, MemorySecretBackend(), write_json=write)
    await store.initialize()
    await store.set("stable", {"value": 1})
    fail = True
    with pytest.raises(RuntimeError, match="simulated write failure"):
        await store.set("failed", {"value": 2})
    assert not store.has("failed")
    assert store.get("stable") == {"value": 1}
    await store.set("recovered", {"value": 3})
    assert store.get("recovered") == {"value": 3}


async def test_reopen_clones_and_absent_remove_leaves_the_index(tmp_path: Path) -> None:
    backend = MemorySecretBackend()
    store = SecretStore(tmp_path, backend)
    await store.initialize()
    await store.set("nested", {"list": [1]})
    await store.flush()
    reopened = SecretStore(tmp_path, backend)
    await reopened.initialize()
    value = reopened.get("nested")
    value["list"].append(2)
    assert reopened.get("nested") == {"list": [1]}
    index = tmp_path / INDEX_FILE
    before = index.read_bytes()
    await reopened.remove("absent")
    assert index.read_bytes() == before


async def test_undefined_and_primitive_token_match_javascript(tmp_path: Path) -> None:
    store = SecretStore(tmp_path, MemorySecretBackend())
    await store.initialize()
    await store.set("undefined", UNDEFINED)
    assert store.get("undefined") is None
    await store.set("primitive", 1)
    assert cast(object, await store.ensure_token("primitive")) is UNDEFINED
    with pytest.raises(TypeError, match="Cannot read properties of null"):
        await store.ensure_token("undefined")


async def test_long_values_are_chunked_and_shrinking_forgets_old_chunks(tmp_path: Path) -> None:
    backend = MemorySecretBackend()
    store = SecretStore(tmp_path, backend)
    await store.initialize()
    long = "x" * (CHUNK * 3)
    await store.set("llm:key", {"key": long})
    assert all(len(value) <= CHUNK + 64 for value in backend.values.values())
    assert json.loads(backend.values[(SERVICE, "llm:key")])["chunks"] == 4
    reopened = SecretStore(tmp_path, backend)
    await reopened.initialize()
    assert reopened.get("llm:key") == {"key": long}
    await reopened.set("llm:key", {"key": "short"})
    assert set(backend.values) == {(SERVICE, "llm:key")}
    await reopened.remove("llm:key")
    assert backend.values == {}


async def test_a_missing_chunk_drops_only_that_secret(tmp_path: Path) -> None:
    backend = MemorySecretBackend()
    store = SecretStore(tmp_path, backend)
    await store.initialize()
    await store.set("long", "y" * (CHUNK * 2))
    await store.set("short", "ok")
    del backend.values[(SERVICE, "long#2")]
    reopened = SecretStore(tmp_path, backend)
    await reopened.initialize()
    assert not reopened.has("long")
    assert reopened.get("short") == "ok"


async def test_file_backend_persists_for_integration_tests(tmp_path: Path) -> None:
    file = tmp_path / "secrets.test.json"
    store = SecretStore(tmp_path, FileSecretBackend(file))
    await store.initialize()
    await store.set("gateway", {"token": "t"})
    reopened = SecretStore(tmp_path, FileSecretBackend(file))
    await reopened.initialize()
    assert reopened.get("gateway") == {"token": "t"}
