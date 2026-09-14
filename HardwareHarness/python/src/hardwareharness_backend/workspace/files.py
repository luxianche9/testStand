from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import threading
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


class WorkspaceService:
    def __init__(self, root_path: str) -> None:
        self.root = Path(root_path).resolve() / ".hardwareharness"
        self._lock = threading.RLock()

    def tree(self) -> list[Record]:
        result: list[Record] = []
        if not self.root.exists():
            return result

        def visit(directory: Path) -> None:
            for child in sorted(
                directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())
            ):
                if child.name.casefold() in HIDDEN or child.name.endswith(".tmp"):
                    continue
                relative = child.relative_to(self.root).as_posix()
                try:
                    source_path(self.root, relative)
                except AppError:
                    continue
                if child.is_symlink() or getattr(child.lstat(), "st_file_attributes", 0) & 0x400:
                    continue
                kind = "directory" if child.is_dir() else "file"
                result.append({"path": relative, "name": child.name, "kind": kind})
                if child.is_dir():
                    visit(child)

        visit(self.root)
        return result

    def read(self, path: str) -> Record:
        target = source_path(self.root, path)
        if not target.is_file():
            raise AppError("not_found", f"File does not exist: {path}")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise AppError("invalid_argument", "File exceeds the 4 MiB editor limit")
        data = target.read_bytes()
        try:
            content = data.decode("utf-8")
            if "\x00" in content:
                raise UnicodeError("Binary content")
        except UnicodeError as error:
            raise AppError("invalid_argument", "The editor only opens UTF-8 text files") from error
        return {"path": path, "content": content, "hash": hashlib.sha256(data).hexdigest()}

    def write(self, path: str, content: str, expected_hash: str) -> Record:
        target = source_path(self.root, path, writable=True)
        data = self._encode(content)
        with self._lock:
            current = self.read(path)
            if current["hash"] != expected_hash:
                raise AppError("conflict", "File changed outside the editor", current)
            atomic_write(target, data)
        return self.read(path)

    def create(self, path: str, kind: str, content: str = "") -> Record:
        target = source_path(self.root, path, writable=True)
        with self._lock:
            if target.exists():
                raise AppError("conflict", f"Path already exists: {path}")
            if kind == "directory":
                target.mkdir(parents=True)
                return {"path": path, "name": target.name, "kind": kind}
            if kind != "file":
                raise AppError("invalid_argument", "Kind must be file or directory")
            data = self._encode(content)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(data)
        return self.read(path)

    def rename(self, path: str, target_path: str) -> Record:
        source = source_path(self.root, path, writable=True)
        target = source_path(self.root, target_path, writable=True)
        with self._lock:
            if not source.exists():
                raise AppError("not_found", f"Path does not exist: {path}")
            if target.exists() or target.resolve().is_relative_to(source.resolve()):
                raise AppError("conflict", "Rename destination already exists or is inside source")
            target.parent.mkdir(parents=True, exist_ok=True)
            source.rename(target)
        return {
            "path": target_path,
            "name": target.name,
            "kind": "directory" if target.is_dir() else "file",
        }

    def delete(self, path: str) -> None:
        target = source_path(self.root, path, writable=True)
        with self._lock:
            if not target.exists():
                raise AppError("not_found", f"Path does not exist: {path}")
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()

    def search(self, query: str) -> list[Record]:
        if not query:
            return []
        result: list[Record] = []
        for item in self.tree():
            if item["kind"] != "file":
                continue
            try:
                content = str(self.read(item["path"])["content"])
            except AppError:
                continue
            for number, line in enumerate(content.splitlines(), 1):
                position = line.casefold().find(query.casefold())
                if position >= 0:
                    result.append(
                        {"path": item["path"], "line": number, "column": position + 1, "text": line}
                    )
                    if len(result) >= 1000:
                        return result
        return result

    def snapshot(self) -> str:
        """Polling token covers external file changes without exposing generated directories."""
        digest = hashlib.sha256()
        for item in self.tree():
            path = self.root / item["path"]
            stat = path.stat()
            digest.update(f"{item['path']}\0{stat.st_mtime_ns}\0{stat.st_size}\n".encode())
        return digest.hexdigest()

    def syntax_diagnostics(self, path: str, content: str | None = None) -> list[Record]:
        source_path(self.root, path)
        if not path.endswith(".py"):
            return []
        text = str(self.read(path)["content"]) if content is None else content
        try:
            ast.parse(text, filename=path)
        except SyntaxError as error:
            return [
                {
                    "path": path,
                    "line": error.lineno or 1,
                    "column": error.offset or 1,
                    "severity": "error",
                    "message": error.msg,
                    "code": "syntax",
                }
            ]
        return []

    async def diagnose(
        self, path: str, content: str | None = None, *, python: str | None = None
    ) -> list[Record]:
        diagnostics = self.syntax_diagnostics(path, content)
        if diagnostics or not path.endswith(".py") or python is None:
            return diagnostics
        text = str(self.read(path)["content"]) if content is None else content
        process = await asyncio.create_subprocess_exec(
            python,
            "-m",
            "ruff",
            "check",
            "--output-format=json",
            "--stdin-filename",
            path,
            "-",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.root,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        stdout, stderr = await process.communicate(text.encode())
        if process.returncode not in (0, 1):
            raise AppError("unavailable", "Python diagnostics could not run", stderr.decode())
        records = json.loads(stdout)
        for record in records:
            diagnostics.append(
                {
                    "path": path,
                    "line": record["location"]["row"],
                    "column": record["location"]["column"],
                    "severity": "warning",
                    "message": record["message"],
                    "code": record["code"],
                }
            )
        return diagnostics

    @staticmethod
    def _encode(content: str) -> bytes:
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES or "\x00" in content:
            raise AppError("invalid_argument", "Text exceeds the editor limit or contains NUL")
        return data
