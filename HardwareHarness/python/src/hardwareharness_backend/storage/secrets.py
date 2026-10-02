"""Credentials in the operating system's credential store (design doc §4.7).

Entries live under the ``HardwareHarness`` service of Python ``keyring`` (Windows Credential
Manager): ``ssh:<computerId>``, ``mcp:<serverId>``, ``gateway``, ``opencode.llm.api-key``.
Only the entry names are kept on disk (``secret-keys.json``) so ``has`` needs no store round
trip; values are read once at startup and kept in memory, so ``get`` never blocks the loop
on the credential store.

A Windows credential blob holds about 1280 characters, so a longer value is split into
``<key>#1`` … ``<key>#n`` with a head entry ``{"v": 1, "chunks": n}``.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import secrets
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol, TypeVar

from hardwareharness_backend.storage.file_storage import atomic_json, read_json
from hardwareharness_backend.storage.serialized_writer import SerializedWriter
from hardwareharness_backend.storage.settings_store import JsonWriter
from hardwareharness_backend.util import UNDEFINED, Record, clone, json_dumps, json_loads

T = TypeVar("T")
SERVICE = "HardwareHarness"
INDEX_FILE = "secret-keys.json"
CHUNK = 1000
"""Characters per credential blob, under the Windows limit of 2560 bytes of UTF-16."""
_log = logging.getLogger(__name__)


class SecretBackend(Protocol):
    """The part of the ``keyring`` API the store uses; tests pass an in-memory one."""

    def get_password(self, service: str, username: str) -> str | None: ...
    def set_password(self, service: str, username: str, password: str) -> None: ...
    def delete_password(self, service: str, username: str) -> None: ...


class MemorySecretBackend:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.values.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.values[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        self.values.pop((service, username), None)


class FileSecretBackend(MemorySecretBackend):
    """Plain-text JSON file, for integration tests only: never the default."""

    def __init__(self, path: str | Path) -> None:
        super().__init__()
        self.path = Path(path)
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
            self.values = {(item[0], item[1]): item[2] for item in stored}
        except (OSError, ValueError, TypeError, IndexError):
            self.values = {}

    def _save(self) -> None:
        self.path.write_text(
            json.dumps([[*key, value] for key, value in self.values.items()]), encoding="utf-8"
        )

    def set_password(self, service: str, username: str, password: str) -> None:
        super().set_password(service, username, password)
        self._save()

    def delete_password(self, service: str, username: str) -> None:
        super().delete_password(service, username)
        self._save()


def system_backend() -> SecretBackend:
    import keyring

    backend: SecretBackend = keyring.get_keyring()
    return backend


class SecretStore:
    def __init__(
        self,
        root: str | Path,
        backend: SecretBackend | None = None,
        *,
        service: str = SERVICE,
        write_json: JsonWriter = atomic_json,
    ) -> None:
        self.root = Path(root)
        self.service = service
        self._backend = backend
        self._write_json = write_json
        self._values: Record = {}
        self._writer = SerializedWriter()

    @property
    def index_path(self) -> Path:
        return self.root / INDEX_FILE

    async def initialize(self) -> None:
        async def operation() -> None:
            if self._backend is None:
                self._backend = await asyncio.to_thread(system_backend)
            stored = await read_json(self.index_path)
            names = stored.get("keys", []) if isinstance(stored, dict) else []
            values: Record = {}
            for name in names if isinstance(names, list) else []:
                if isinstance(name, str):
                    value = await asyncio.to_thread(self._read, name)
                    if value is not UNDEFINED:
                        values[name] = value
            self._values = values
            await self._write_index(self._values)

        await self._writer.enqueue(operation)

    def has(self, key: str) -> bool:
        return key in self._values

    def get(self, key: str) -> Any:
        if key not in self._values:
            raise RuntimeError(f"Secret not found: {key}")
        return clone(self._values[key])

    async def set(self, key: str, value: Any) -> None:
        def mutate(values: Record) -> tuple[bool, None]:
            self._write(key, value)
            values[key] = None if value is UNDEFINED else clone(value)  # Stored as JSON null.
            return True, None

        await self._enqueue(mutate)

    async def remove(self, key: str) -> None:
        def mutate(values: Record) -> tuple[bool, None]:
            if key not in values:
                return False, None
            self._delete(key)
            del values[key]
            return True, None

        await self._enqueue(mutate)

    async def ensure_token(self, key: str) -> str:
        def mutate(values: Record) -> tuple[bool, str]:
            if key in values:
                value = values[key]
                if value is None:
                    raise TypeError("Cannot read properties of null (reading 'token')")
                token_value = (
                    value.get("token", UNDEFINED) if isinstance(value, dict) else UNDEFINED
                )
                return False, token_value  # type: ignore[return-value]
            token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
            self._write(key, {"token": token})
            values[key] = {"token": token}
            return True, token

        return await self._enqueue(mutate)

    async def flush(self) -> None:
        await self._writer.flush()

    async def _enqueue(self, mutate: Callable[[Record], tuple[bool, T]]) -> T:
        async def operation() -> T:
            values = dict(self._values)
            changed, result = mutate(values)
            if changed:
                # The index first: when it fails the value was never committed, even though
                # the credential store already holds it (reads go through the index).
                await self._write_index(values)
                self._values = values
            return result

        return await self._writer.enqueue(operation)

    async def _write_index(self, values: Record) -> None:
        await self._write_json(
            self.index_path, {"formatVersion": 2, "service": self.service, "keys": sorted(values)}
        )

    # Credential store layout ----------------------------------------------------------

    @property
    def _store(self) -> SecretBackend:
        if self._backend is None:
            raise RuntimeError("SecretStore is not initialized")
        return self._backend

    def _read(self, key: str) -> Any:
        head = self._store.get_password(self.service, key)
        if head is None:
            return UNDEFINED
        envelope = json.loads(head)
        if "chunks" in envelope:
            parts = [
                self._store.get_password(self.service, f"{key}#{index}")
                for index in range(1, int(envelope["chunks"]) + 1)
            ]
            if any(part is None for part in parts):
                _log.warning("Secret %s is missing a chunk; ignoring it", key)
                return UNDEFINED
            return json_loads("".join(part or "" for part in parts))
        return json_loads(envelope["value"]) if "value" in envelope else None

    def _write(self, key: str, value: Any) -> None:
        text = "null" if value is UNDEFINED else json_dumps(value)
        previous = self._chunk_count(key)
        if len(text) + 32 <= CHUNK:
            self._store.set_password(
                self.service, key, json.dumps({"v": 1, "value": text}, separators=(",", ":"))
            )
            chunks = 0
        else:
            parts = [text[index : index + CHUNK] for index in range(0, len(text), CHUNK)]
            for index, part in enumerate(parts, 1):
                self._store.set_password(self.service, f"{key}#{index}", part)
            self._store.set_password(
                self.service, key, json.dumps({"v": 1, "chunks": len(parts)}, separators=(",", ":"))
            )
            chunks = len(parts)
        for index in range(chunks + 1, previous + 1):
            self._forget(f"{key}#{index}")

    def _delete(self, key: str) -> None:
        for index in range(1, self._chunk_count(key) + 1):
            self._forget(f"{key}#{index}")
        self._forget(key)

    def _chunk_count(self, key: str) -> int:
        try:
            head = self._store.get_password(self.service, key)
            return int(json.loads(head).get("chunks", 0)) if head else 0
        except (ValueError, TypeError, AttributeError):
            return 0

    def _forget(self, name: str) -> None:
        # keyring raises PasswordDeleteError for a missing entry.
        with contextlib.suppress(Exception):
            self._store.delete_password(self.service, name)
