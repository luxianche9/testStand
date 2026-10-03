import asyncio
import errno
import os
from contextlib import suppress
from pathlib import Path
from typing import Any

from teststand_backend.util import UNDEFINED, json_dumps, json_loads, new_uuid


def _sync_directory(path: str | Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
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
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(f"{target}.{new_uuid()}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(value.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        _sync_directory(target.parent)
    except BaseException:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise


async def atomic_text(path: str | Path, value: str) -> None:
    await asyncio.to_thread(_atomic_text, path, value)


async def atomic_json(path: str | Path, value: Any) -> None:
    await atomic_text(path, json_dumps(value, 2) + "\n")


async def read_json(path: str | Path) -> Any:
    try:
        data = await asyncio.to_thread(Path(path).read_bytes)
    except FileNotFoundError:
        return UNDEFINED
    return json_loads(data.decode("utf-8", "replace"))
