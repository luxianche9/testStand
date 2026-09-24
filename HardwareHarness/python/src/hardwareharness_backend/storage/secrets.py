import base64
import re
import secrets
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol, TypeVar, cast

from hardwareharness_backend.contracts.storage import parse_encrypted_secret_file
from hardwareharness_backend.storage.file_storage import atomic_json, read_json
from hardwareharness_backend.storage.serialized_writer import SerializedWriter
from hardwareharness_backend.storage.settings_store import JsonWriter
from hardwareharness_backend.util import UNDEFINED, Record, clone, json_dumps, json_loads

T = TypeVar("T")


class SecretProtector(Protocol):
    def encrypt(self, value: str) -> bytes: ...
    def decrypt(self, value: bytes) -> str: ...


class SecretStore:
    def __init__(
        self, path: str | Path, protector: SecretProtector, write_json: JsonWriter = atomic_json
    ) -> None:
        self.path = path
        self._protector = protector
        self._write_json = write_json
        self._value: Record = {"formatVersion": 1, "entries": {}}
        self._writer = SerializedWriter()

    async def initialize(self) -> None:
        async def operation() -> None:
            stored = await read_json(self.path)
            if stored is not UNDEFINED:
                self._value = parse_encrypted_secret_file(stored)
            await self._write_json(self.path, self._value)

        await self._writer.enqueue(operation)

    def has(self, key: str) -> bool:
        return key in self._value["entries"]

    async def set(self, key: str, value: Any) -> None:
        def mutate(next_value: Record) -> tuple[bool, None]:
            next_value["entries"][key] = self._encode(value)
            return True, None

        await self._enqueue(mutate)

    def get(self, key: str) -> Any:
        encoded = self._value["entries"].get(key)
        if not encoded:
            raise RuntimeError(f"Secret not found: {key}")
        return self._decode(encoded)

    async def remove(self, key: str) -> None:
        def mutate(next_value: Record) -> tuple[bool, None]:
            if key not in next_value["entries"]:
                return False, None
            del next_value["entries"][key]
            return True, None

        await self._enqueue(mutate)

    async def ensure_token(self, key: str) -> str:
        def mutate(next_value: Record) -> tuple[bool, str]:
            encoded = next_value["entries"].get(key)
            if encoded:
                value = self._decode(encoded)
                if value is None:
                    raise TypeError("Cannot read properties of null (reading 'token')")
                token_value = (
                    value.get("token", UNDEFINED) if isinstance(value, dict) else UNDEFINED
                )
                return False, cast(str, token_value)
            token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
            next_value["entries"][key] = self._encode({"token": token})
            return True, token

        return await self._enqueue(mutate)

    async def flush(self) -> None:
        await self._writer.flush()

    def _encode(self, value: Any) -> str:
        serialized = UNDEFINED if value is UNDEFINED else json_dumps(value)
        return base64.b64encode(self._protector.encrypt(cast(str, serialized))).decode("ascii")

    def _decode(self, encoded: str) -> Any:
        # Buffer.from(base64) accepts the URL alphabet, ignores nonalphabet bytes,
        # stops at padding, and ignores an incomplete final six-bit digit.
        digits = re.sub(
            r"[^A-Za-z0-9+/]", "", encoded.split("=", 1)[0].translate(str.maketrans("-_", "+/"))
        )
        if len(digits) % 4 == 1:
            digits = digits[:-1]
        return json_loads(self._protector.decrypt(base64.b64decode(digits + "===")))

    async def _enqueue(self, mutate: Callable[[Record], tuple[bool, T]]) -> T:
        async def operation() -> T:
            next_value = clone(self._value)
            changed, result = mutate(next_value)
            if changed:
                await self._write_json(self.path, next_value)
                self._value = next_value
            return result

        return await self._writer.enqueue(operation)
