import asyncio
import errno
import os
from contextlib import suppress
from pathlib import Path
from typing import Any

from hardwareharness_backend.compat import (
    UNDEFINED,
    json_parse,
    json_stringify,
    new_uuid,
    utf8_bytes,
)
from hardwareharness_backend.compat.filesystem import fs_operation, mkdir, read_bytes, replace


def _sync_directory(path: str | Path) -> None:
    try:
        with fs_operation("open", path):
            descriptor = os.open(path, os.O_RDONLY)
        try:
            with fs_operation("fsync"):
                os.fsync(descriptor)
        finally:
            with fs_operation("close"):
                os.close(descriptor)
    except OSError as error:
        if error.errno not in (
            errno.EACCES,
            errno.EBADF,
            errno.EINVAL,
            errno.EISDIR,
            errno.ENOENT,
            errno.ENOTSUP,
            errno.EPERM,
        ):
            raise


async def sync_directory(path: str | Path) -> None:
    await asyncio.to_thread(_sync_directory, path)


def _atomic_text(path: str | Path, value: str) -> None:
    target = Path(path)
    mkdir(target.parent)
    temporary = Path(f"{target}.{new_uuid()}.tmp")
    try:
        with fs_operation("open", temporary), temporary.open("xb") as handle:
            with fs_operation("write"):
                handle.write(utf8_bytes(value))
                handle.flush()
            with fs_operation("fsync"):
                os.fsync(handle.fileno())
        replace(temporary, target)
        _sync_directory(target.parent)
    except BaseException:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise


async def atomic_text(path: str | Path, value: str) -> None:
    await asyncio.to_thread(_atomic_text, path, value)


async def atomic_json(path: str | Path, value: Any) -> None:
    await atomic_text(path, json_stringify(value, 2) + "\n")


async def read_json(path: str | Path) -> Any:
    try:
        data = await asyncio.to_thread(read_bytes, path)
    except FileNotFoundError:
        return UNDEFINED
    return json_parse(data.decode("utf-8", "replace"))
