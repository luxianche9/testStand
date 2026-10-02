"""SecretStore over a credential-store backend (design doc §4.7)."""

import asyncio
import base64
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


class Legacy:
    """Stands in for the safeStorage reader: the "ciphertext" is the UTF-8 plaintext."""

    def __init__(self, broken: frozenset[str] = frozenset()) -> None:
        self.broken = broken

    def decrypt(self, value: bytes) -> str:
        text = value.decode("utf-8")
        if text in self.broken:
            raise RuntimeError("bad ciphertext")
        return text


async def legacy_file(root: Path, entries: dict[str, Any]) -> Path:
    path = root / "secrets.json"
    encoded = {
        key: base64.b64encode(json.dumps(value).encode()).decode() for key, value in entries.items()
    }
    await atomic_json(path, {"formatVersion": 1, "entries": encoded})
    return path


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
    await store.set("mcp:server", {"key": long})
    assert all(len(value) <= CHUNK + 64 for value in backend.values.values())
    assert json.loads(backend.values[(SERVICE, "mcp:server")])["chunks"] == 4
    reopened = SecretStore(tmp_path, backend)
    await reopened.initialize()
    assert reopened.get("mcp:server") == {"key": long}
    await reopened.set("mcp:server", {"key": "short"})
    assert set(backend.values) == {(SERVICE, "mcp:server")}
    await reopened.remove("mcp:server")
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


async def test_legacy_file_is_imported_once_and_renamed(tmp_path: Path) -> None:
    path = await legacy_file(tmp_path, {"gateway": {"token": "t"}, "ssh:pc": {"password": "p"}})
    backend = MemorySecretBackend()
    store = SecretStore(tmp_path, backend, legacy=Legacy())
    await store.initialize()
    assert store.get("gateway") == {"token": "t"}
    assert store.get("ssh:pc") == {"password": "p"}
    assert not path.exists()
    assert path.with_name("secrets.json.imported").exists()
    assert (await read_json(tmp_path / INDEX_FILE))["keys"] == ["gateway", "ssh:pc"]
    reopened = SecretStore(tmp_path, backend)
    await reopened.initialize()
    assert reopened.get("ssh:pc") == {"password": "p"}


async def test_legacy_import_never_overwrites_and_keeps_the_file_on_failure(
    tmp_path: Path,
) -> None:
    backend = MemorySecretBackend()
    store = SecretStore(tmp_path, backend)
    await store.initialize()
    await store.set("gateway", {"token": "current"})
    path = await legacy_file(tmp_path, {"gateway": {"token": "old"}, "broken": "b", "ok": 1})
    reopened = SecretStore(tmp_path, backend, legacy=Legacy(frozenset({'"b"'})))
    await reopened.initialize()
    assert reopened.get("gateway") == {"token": "current"}
    assert reopened.get("ok") == 1
    assert not reopened.has("broken")
    assert path.exists()  # Retried on the next start.


async def test_legacy_file_without_a_reader_is_left_alone(tmp_path: Path) -> None:
    path = await legacy_file(tmp_path, {"gateway": {"token": "t"}})
    store = SecretStore(tmp_path, MemorySecretBackend())
    await store.initialize()
    assert not store.has("gateway")
    assert path.exists()


async def test_file_backend_persists_for_integration_tests(tmp_path: Path) -> None:
    file = tmp_path / "secrets.test.json"
    store = SecretStore(tmp_path, FileSecretBackend(file))
    await store.initialize()
    await store.set("gateway", {"token": "t"})
    reopened = SecretStore(tmp_path, FileSecretBackend(file))
    await reopened.initialize()
    assert reopened.get("gateway") == {"token": "t"}
