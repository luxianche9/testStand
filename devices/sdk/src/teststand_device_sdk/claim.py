"""Exclusive claim of a physical resource (a card, a port) across every process on this computer.

Vendor drivers usually let any number of handles open the same card; two device instances bound
to one card then reset it under each other and split its data between them. A plugin claims the
card before touching it: the second claim fails with a clear error naming the resource. The claim
is an OS file lock, so it is released when the claim is closed or the process dies.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import IO, Self

from .errors import DEVICE_UNREACHABLE, DeviceError

CLAIMS_ENV = "TESTSTAND_CLAIMS_DIR"
# Windows byte locks are mandatory: lock a byte past the holder's name so others can still read it.
LOCK_OFFSET = 1 << 20


def _directory() -> Path:
    path = Path(os.environ.get(CLAIMS_ENV) or Path(tempfile.gettempdir()) / "teststand-claims")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _lock(handle: IO[bytes]) -> bool:
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


class Claim:
    """A held claim; ``release`` (or closing the process) gives the resource back."""

    def __init__(self, key: str, handle: IO[bytes], path: Path) -> None:
        self.key, self._handle, self.path = key, handle, path

    @property
    def held(self) -> bool:
        return not self._handle.closed

    def release(self) -> None:
        if self._handle.closed:
            return
        if os.name == "nt":
            import msvcrt

            try:
                self._handle.seek(LOCK_OFFSET)
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        self._handle.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.release()


def claim_resource(key: str, *, owner: str = "") -> Claim:
    """Claim ``key`` (e.g. ``"jcxd_mads3210/card0"``) for this process, or raise ``DeviceError``
    (``device_unreachable``) naming whoever holds it. ``owner`` is recorded for that message."""
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", key) + ".lock"
    path = _directory() / name
    handle = open(path, "a+b")  # noqa: SIM115 - held for the claim's life
    if not _lock(handle):
        handle.seek(0)
        holder = handle.read().decode("utf-8", "replace").strip() or "another process"
        handle.close()
        raise DeviceError(
            f"{key} is already in use by {holder}; one physical card can serve one device instance only",
            category=DEVICE_UNREACHABLE,
            details={"resource": key, "holder": holder},
        )
    handle.seek(0)
    handle.truncate()
    handle.write(f"{owner or 'device'} (pid {os.getpid()})".encode())
    handle.flush()
    return Claim(key, handle, path)
