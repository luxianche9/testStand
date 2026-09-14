from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

Json = dict[str, Any]
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_PRIVATE = {"authorization", "password", "secret", "token", "accesstoken", "bearertoken"}


def timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if str(key).lower() in _PRIVATE else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def safe_child(root: Path, name: str) -> Path:
    candidate = (root / name).resolve()
    if candidate == root.resolve() or not candidate.is_relative_to(root.resolve()):
        raise ValueError("Path must remain inside its workspace")
    return candidate


def atomic_json(path: Path, value: Json) -> None:
    data = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()
    temporary = path.with_suffix(".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            with temporary.open("wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(path)
            return
        except OSError:
            if attempt == 2:
                raise
            time.sleep(0.02 * 2**attempt)


class RunLogStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.directory = self.root / ".hardwareharness" / "logs" / "application-runs"
        self.artifacts = self.root / ".hardwareharness" / "artifacts"

    def path(self, run_id: str) -> Path:
        if not _ID.fullmatch(run_id):
            raise ValueError("Invalid Run ID")
        if not self.directory.resolve().is_relative_to(self.root):
            raise ValueError("Run directory must remain inside the project")
        return safe_child(self.directory, run_id)

    def read(self, run_id: str) -> Json:
        value: Json = json.loads((self.path(run_id) / "run.json").read_text(encoding="utf-8"))
        return value

    def save(self, record: Json) -> None:
        atomic_json(self.path(record["runId"]) / "run.json", redact(record))

    def append(self, record: Json, kind: str, data: Json, **identity: Any) -> Json:
        event = {
            "runId": record["runId"],
            "sequence": record.get("eventCount", 0) + 1,
            "timestamp": timestamp(),
            "type": kind,
            "data": redact(data),
            **identity,
        }
        event = redact(event)
        encoded = (
            json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
        ).encode()
        path = self.path(record["runId"]) / "events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        # An append is never retried: a partial write must not duplicate a hardware intent.
        with path.open("ab") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        record["eventCount"] = event["sequence"]
        self.save(record)
        return cast(Json, event)

    def events(self, run_id: str, after: int = 0, limit: int = 500) -> list[Json]:
        path = self.path(run_id) / "events.jsonl"
        if not path.exists():
            return []
        result: list[Json] = []
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    event: Json = json.loads(line)
                except ValueError:
                    # A crash can leave only the final line incomplete; interior damage is an error.
                    if stream.read().strip():
                        raise ValueError("Corrupt Run event journal") from None
                    break
                if event["sequence"] > after:
                    result.append(event)
                    if len(result) >= limit:
                        break
        return result

    def list(self) -> list[Json]:
        if not self.directory.exists():
            return []
        records = [
            self.read(path.name)
            for path in self.directory.iterdir()
            if (path / "run.json").is_file()
        ]
        return sorted(records, key=lambda item: item["startedAt"], reverse=True)

    def recover(self, active_ids: set[str]) -> None:
        for record in self.list():
            if record["runId"] in active_ids or record["status"] not in {"running", "cancelling"}:
                continue
            events = self.events(record["runId"], limit=2**31 - 1)
            journal = self.path(record["runId"]) / "events.jsonl"
            if journal.exists():
                contents = journal.read_bytes()
                if contents and not contents.endswith(b"\n"):
                    boundary = contents.rfind(b"\n") + 1
                    # Preserve the incomplete bytes for diagnosis before restoring the journal.
                    journal.with_suffix(".partial").write_bytes(contents[boundary:])
                    with journal.open("r+b") as stream:
                        stream.truncate(boundary)
                        stream.flush()
                        os.fsync(stream.fileno())
            record["eventCount"] = events[-1]["sequence"] if events else 0
            record.update(
                status="interrupted",
                completedAt=timestamp(),
                error={
                    "category": "error",
                    "message": "HardwareHarness stopped before this Run completed; "
                    "hardware operations were not replayed",
                },
            )
            self.append(
                record, "run.completed", {"status": "interrupted", "error": record["error"]}
            )

    def snapshot(self, run_id: str) -> tuple[Path, Json]:
        workspace = self.root / ".hardwareharness"
        destination = self.path(run_id) / "source"
        destination.mkdir(parents=True, exist_ok=True)
        hashes: Json = {}
        ignored = {
            ".venv",
            ".git",
            "__pycache__",
            ".ruff_cache",
            ".mypy_cache",
            ".pytest_cache",
            "logs",
            "artifacts",
            "backups",
            "node_modules",
        }
        for folder, directories, filenames in os.walk(workspace):
            directories[:] = [name for name in directories if name not in ignored]
            for directory in directories:
                if (Path(folder) / directory).is_symlink():
                    raise ValueError("Workflow snapshots cannot include symbolic directories")
            for filename in filenames:
                path = Path(folder) / filename
                relative = path.relative_to(workspace)
                if path.is_symlink() or not path.resolve().is_relative_to(workspace.resolve()):
                    raise ValueError(
                        "Workflow snapshots cannot include files outside the workspace"
                    )
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                contents = path.read_bytes()
                target.write_bytes(contents)
                hashes[relative.as_posix()] = hashlib.sha256(contents).hexdigest()
        return destination, hashes

    def attachment(self, run_id: str, source: Path, name: str | None = None) -> Json:
        self.path(run_id)
        if not self.artifacts.resolve().is_relative_to(self.root):
            raise ValueError("Artifacts must remain inside the project")
        if not source.is_file():
            raise ValueError("Attachment must be an existing file")
        # Ordinary local Python may generate attachments anywhere; destinations are confined.
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        filename = Path(name or source.name).name
        if filename in {"", ".", ".."}:
            raise ValueError("Invalid attachment name")
        target = safe_child(self.artifacts / run_id, f"{digest[:16]}-{filename}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return {
            "name": filename,
            "path": target.relative_to(self.root).as_posix(),
            "size": target.stat().st_size,
            "sha256": digest,
        }

    def delete(self, run_id: str) -> None:
        path = self.path(run_id)
        artifacts = safe_child(self.artifacts, run_id)
        if path.exists():
            shutil.rmtree(path)
        if artifacts.exists():
            shutil.rmtree(artifacts)
