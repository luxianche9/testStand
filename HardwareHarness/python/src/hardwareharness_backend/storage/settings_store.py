from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from hardwareharness_backend.contracts.storage import parse_user_settings
from hardwareharness_backend.storage.file_storage import atomic_json, read_json
from hardwareharness_backend.storage.serialized_writer import SerializedWriter
from hardwareharness_backend.util import UNDEFINED, Record, clone

JsonWriter = Callable[[str | Path, Any], Awaitable[None]]


class SettingsStore:
    def __init__(self, path: str | Path, write_json: JsonWriter = atomic_json) -> None:
        self.path = path
        self._write_json = write_json
        self._value = parse_user_settings({"formatVersion": 1})
        self._writer = SerializedWriter()

    async def initialize(self) -> None:
        async def operation() -> None:
            stored = await read_json(self.path)
            if stored is not UNDEFINED:
                self._value = parse_user_settings(stored)
            await self._write_json(self.path, self._value)

        await self._writer.enqueue(operation)

    def get(self) -> Record:
        return clone(self._value)

    async def update(self, patch: Record) -> Record:
        async def operation() -> Record:
            next_value = parse_user_settings({**self._value, **patch, "formatVersion": 1})
            await self._write_json(self.path, next_value)
            self._value = next_value
            return self.get()

        return await self._writer.enqueue(operation)

    async def flush(self) -> None:
        await self._writer.flush()
