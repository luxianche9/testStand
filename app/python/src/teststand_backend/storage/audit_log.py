"""Append-only JSONL audit log of operations (design doc §9.3 step 6), rotated by size."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

DEFAULT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_BACKUPS = 3


class AuditLog:
    """``audit.jsonl`` plus ``audit.1.jsonl`` … ``audit.<backups>.jsonl``, oldest last.

    Records are already redacted and bounded by the caller; a write failure never fails
    the operation that is being audited.
    """

    def __init__(
        self,
        path: str | Path,
        max_bytes: int = DEFAULT_MAX_BYTES,
        backups: int = DEFAULT_BACKUPS,
    ) -> None:
        self.path = Path(path)
        self.max_bytes = max_bytes
        self.backups = backups
        self._lock = threading.Lock()

    def append(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"), default=str) + "\n"
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self.path.exists() and self.path.stat().st_size + len(line) > self.max_bytes:
                    self._rotate()
                with self.path.open("a", encoding="utf-8", newline="\n") as file:
                    file.write(line)
            except OSError:
                pass

    def read(self, limit: int = 200) -> list[dict[str, Any]]:
        """The newest ``limit`` records of the current file, oldest first."""
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        records: list[dict[str, Any]] = []
        for line in lines[-limit:] if limit > 0 else []:
            try:
                records.append(json.loads(line))
            except ValueError:
                continue
        return records

    def _rotate(self) -> None:
        stem, suffix = self.path.stem, self.path.suffix
        for index in range(self.backups, 0, -1):
            source = self.path if index == 1 else self.path.with_name(f"{stem}.{index - 1}{suffix}")
            target = self.path.with_name(f"{stem}.{index}{suffix}")
            if source.exists():
                source.replace(target)
        if self.backups <= 0:
            self.path.unlink(missing_ok=True)
