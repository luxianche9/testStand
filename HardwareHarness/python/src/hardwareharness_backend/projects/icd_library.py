"""The project's ICD files, ``<project>/icd/<name>.icd.yaml`` (design §6.2).

Files are plain text the Agent or the user edits; this reads, validates and writes them. A
parsed ICD is cached until its file changes.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from hardwareharness_backend.contracts.errors import AppError, app_error
from hardwareharness_backend.protocol import Icd, icd_hash, load_icd
from hardwareharness_backend.protocol.derived import ALIAS
from hardwareharness_backend.protocol.loader import ICD_SUFFIX, icd_name_from_path

Record = dict[str, Any]


class IcdLibrary:
    def __init__(self, projects: Any) -> None:
        self.projects = projects
        self._cache: dict[Path, tuple[float, int, Icd]] = {}

    def directory(self) -> Path | None:
        session = self.projects.session()
        return Path(session["rootPath"]) / "icd" if session else None

    def _path(self, name: str) -> Path:
        directory = self.directory()
        if directory is None:
            raise app_error("requires_project", "requires_project")
        if not ALIAS.match(name):
            raise app_error("invalid_argument", f"Invalid ICD name {name!r}")
        return directory / f"{name}{ICD_SUFFIX}"

    def get(self, name: str) -> Icd | None:
        """The valid ICD of that name, or ``None`` (no project, no file or invalid file)."""
        try:
            return self.load(name)
        except AppError:
            return None

    def load(self, name: str) -> Icd:
        path = self._path(name)
        try:
            stat = path.stat()
        except FileNotFoundError:
            raise app_error("not_found", f"ICD {name} not found", {"name": name}) from None
        cached = self._cache.get(path)
        if cached is not None and cached[:2] == (stat.st_mtime, stat.st_size):
            return cached[2]
        icd = load_icd(path.read_text(encoding="utf-8"))
        if icd.name != name:
            raise app_error(
                "validation_failed",
                f"{path.name} declares name {icd.name!r}; the file name must match",
                {"name": name},
            )
        self._cache[path] = (stat.st_mtime, stat.st_size, icd)
        return icd

    def list(self) -> list[Record]:
        """Every ``*.icd.yaml`` with its validity (and hash / messages when valid)."""
        directory = self.directory()
        if directory is None or not directory.is_dir():
            return []
        output: list[Record] = []
        for path in sorted(directory.glob(f"*{ICD_SUFFIX}")):
            name = icd_name_from_path(path.name)
            if name is None:
                continue
            entry: Record = {"name": name, "file": f"icd/{path.name}"}
            try:
                icd = self.load(name)
            except AppError as error:
                entry.update(valid=False, error=str(error))
            else:
                entry.update(
                    valid=True,
                    icdHash=icd_hash(icd),
                    transport=icd.transport,
                    description=icd.description,
                    messages=[message.name for message in icd.messages],
                    encoders=[encoder.name for encoder in icd.encoders],
                )
            output.append(entry)
        return output

    def read_text(self, name: str) -> str:
        path = self._path(name)
        if not path.is_file():
            raise app_error("not_found", f"ICD {name} not found", {"name": name})
        return path.read_text(encoding="utf-8")

    def save_text(self, name: str, text: str) -> Icd:
        """Validate, then atomically replace the file; an invalid ICD is not written."""
        icd = load_icd(text)
        if icd.name != name:
            raise app_error(
                "validation_failed", f"The ICD declares name {icd.name!r}; expected {name!r}"
            )
        path = self._path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="") as stream:
                stream.write(text)
            os.replace(temp, path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise
        self._cache.pop(path, None)
        return icd
