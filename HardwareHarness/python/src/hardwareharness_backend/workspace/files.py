from __future__ import annotations

import os
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from hardwareharness_backend.contracts.errors import AppError

Record = dict[str, Any]
HIDDEN = frozenset(
    {
        ".venv",
        ".git",
        "__pycache__",
        ".ruff_cache",
        ".mypy_cache",
        ".pytest_cache",
        "logs",
        "artifacts",
        "snapshots",
        "backups",
        "runtime",
        "migration-backups",
    }
)
READONLY = HIDDEN | {"project.json", "uv.lock"}
MAX_FILE_BYTES = 4 * 1024 * 1024
_RESERVED = {"con", "prn", "aux", "nul"} | {
    f"{prefix}{number}" for prefix in ("com", "lpt") for number in range(1, 10)
}


def source_path(root: Path, relative: str, *, writable: bool = False) -> Path:
    """Validate before resolving, including NTFS alternate streams and reparse points."""
    if (
        not relative
        or "\\" in relative
        or ":" in relative
        or "\x00" in relative
        or PureWindowsPath(relative).is_absolute()
        or PurePosixPath(relative).is_absolute()
        or any(part in {"", ".", ".."} for part in relative.split("/"))
        or any(
            part.rstrip(" .") != part or part.split(".")[0].casefold() in _RESERVED
            for part in relative.split("/")
        )
    ):
        raise AppError("invalid_argument", "Path must be relative to the project workspace")
    parts = PurePosixPath(relative).parts
    if any(part.casefold() in HIDDEN for part in parts) or (
        writable and parts[0].casefold() in READONLY
    ):
        raise AppError("permission_denied", "This path is managed by the platform")
    resolved_root = root.resolve()
    result = root.joinpath(*parts)
    if not result.resolve().is_relative_to(resolved_root):
        raise AppError("permission_denied", "Path resolves outside the project workspace")
    # Junctions within the workspace can still alias a protected platform directory.
    resolved_parts = result.resolve().relative_to(resolved_root).parts
    if any(part.casefold() in HIDDEN for part in resolved_parts) or (
        writable and any(part.casefold() in READONLY for part in resolved_parts)
    ):
        raise AppError("permission_denied", "This path is managed by the platform")
    return result


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
