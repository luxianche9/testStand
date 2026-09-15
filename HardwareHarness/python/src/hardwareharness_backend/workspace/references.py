"""Versioned, bounded documentation access without exposing the installed source tree."""

from __future__ import annotations

import hashlib
import json
import re
from importlib.resources import files
from pathlib import Path
from typing import Any

from hardwareharness import __contract_revision__
from hardwareharness import __version__ as sdk_version
from hardwareharness_backend import __version__ as app_version
from hardwareharness_backend.contracts.errors import AppError

from .files import MAX_FILE_BYTES, atomic_write, source_path

Json = dict[str, Any]
_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\Z")
_BUNDLED = {
    "hh-sdk": ("HardwareHarness Python SDK", "sdk-guide.md"),
    "hh-agent-interface": ("HardwareHarness public interface and recovery", "agent-interface.md"),
}


def versions() -> Json:
    return {
        "appVersion": app_version,
        "sdkVersion": sdk_version,
        "contractRevision": __contract_revision__,
    }


def bundled_reference(reference_id: str) -> Json:
    title, filename = _BUNDLED[reference_id]
    content = files(__package__).joinpath("templates", filename).read_text("utf-8")
    return {
        "referenceId": reference_id,
        "title": title,
        "origin": "bundled",
        "source": f"hardwareharness:{reference_id}@{__contract_revision__}",
        **versions(),
        "sha256": hashlib.sha256(content.encode()).hexdigest(),
        "content": content,
    }


class ReferenceService:
    def __init__(self, root_path: str | None = None) -> None:
        self.root = Path(root_path).resolve() if root_path else None

    def _registry(self) -> tuple[Path, Json]:
        if self.root is None:
            raise AppError("requires_project", "Open a project to register reference documents")
        path = source_path(self.root / ".hardwareharness", "docs/references/index.json")
        if not path.exists():
            return path, {}
        if path.stat().st_size > MAX_FILE_BYTES:
            raise AppError("invalid_argument", "Reference registry exceeds 4 MiB")
        try:
            value = json.loads(path.read_text("utf-8"))
        except (ValueError, UnicodeError) as error:
            raise AppError("invalid_argument", "Reference registry is invalid") from error
        if not isinstance(value, dict):
            raise AppError("invalid_argument", "Reference registry is invalid")
        return path, value

    def index(self) -> list[Json]:
        output = [self._metadata(bundled_reference(key)) for key in _BUNDLED]
        if self.root is not None:
            _, registry = self._registry()
            output.extend(self._metadata(self._user_reference(key)) for key in sorted(registry))
        return output

    @staticmethod
    def _metadata(reference: Json) -> Json:
        return {key: value for key, value in reference.items() if key != "content"}

    def _user_reference(self, reference_id: str) -> Json:
        _, registry = self._registry()
        entry = registry.get(reference_id)
        if not isinstance(entry, dict) or not _ID.fullmatch(reference_id):
            raise AppError("not_found", f"Unknown referenceId: {reference_id}")
        assert self.root is not None
        digest = entry.get("sha256", "")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise AppError("invalid_argument", "Reference registry has an invalid content hash")
        path = source_path(self.root / ".hardwareharness", f"docs/references/{digest}.txt")
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                raise AppError("invalid_argument", "Reference exceeds 4 MiB")
            data = path.read_bytes()
            content = data.decode("utf-8")
        except (OSError, UnicodeError) as error:
            raise AppError("unavailable", "Registered reference content cannot be read") from error
        if hashlib.sha256(data).hexdigest() != digest:
            raise AppError("conflict", "Registered reference changed; register its current source")
        return {**entry, "referenceId": reference_id, "content": content}

    def register(self, value: Json) -> Json:
        reference_id = value["referenceId"]
        if not _ID.fullmatch(reference_id) or reference_id in _BUNDLED:
            raise AppError(
                "invalid_argument", "Use a unique referenceId with letters, digits, - or _"
            )
        index_path, registry = self._registry()
        assert self.root is not None
        path = source_path(self.root, value["path"])
        if path.suffix.lower() not in {".md", ".txt", ".json", ".csv"}:
            raise AppError(
                "invalid_argument",
                "Reference format must be UTF-8 .md, .txt, .json or .csv",
                {"recovery": "Export the relevant document text to a supported project file."},
            )
        if not path.is_file():
            raise AppError("not_found", "Reference source does not exist in the user project")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise AppError("invalid_argument", "Reference exceeds 4 MiB")
        data = path.read_bytes()
        try:
            if "\x00" in data.decode("utf-8"):
                raise UnicodeError("Binary content")
        except UnicodeError as error:
            raise AppError("invalid_argument", "References must contain UTF-8 text") from error
        previous = registry.get(reference_id)
        if previous and value.get("expectedHash") != previous["sha256"]:
            raise AppError("conflict", "Reference already exists; supply its current expectedHash")
        if not previous and value.get("expectedHash"):
            raise AppError("conflict", "Reference no longer exists; read the reference index again")
        digest = hashlib.sha256(data).hexdigest()
        entry = {
            "referenceId": reference_id,
            "title": value["title"],
            "origin": "project",
            "source": value["path"],
            "sha256": digest,
            **({"hardwareId": value["hardwareId"]} if value.get("hardwareId") else {}),
        }
        target = source_path(self.root / ".hardwareharness", f"docs/references/{digest}.txt")
        atomic_write(target, data)
        registry[reference_id] = entry
        atomic_write(
            index_path, (json.dumps(registry, ensure_ascii=False, indent=2) + "\n").encode()
        )
        return entry

    def read(self, value: Json) -> Json:
        reference_id, query = value.get("referenceId"), value.get("query")
        offset, limit = value.get("offset", 0), value.get("limit", 100)
        if not reference_id and not query:
            entries = self.index()
            return self._page(entries, offset, limit, "references")
        references = (
            [
                bundled_reference(reference_id)
                if reference_id in _BUNDLED
                else self._user_reference(reference_id)
            ]
            if reference_id
            else [self._load(entry["referenceId"]) for entry in self.index()]
        )
        rows: list[Json] = []
        for reference in references:
            for line_number, line in enumerate(reference["content"].splitlines(), 1):
                if query is None or query.casefold() in line.casefold():
                    # One pathological line must not expand a bounded page to several MiB.
                    for column in range(0, max(1, len(line)), 1000):
                        rows.append(
                            {
                                "referenceId": reference["referenceId"],
                                "line": line_number,
                                "column": column + 1,
                                "text": line[column : column + 1000],
                            }
                        )
        result = self._page(rows, offset, limit, "lines")
        result["sources"] = [self._metadata(reference) for reference in references]
        return result

    def _load(self, reference_id: str) -> Json:
        return (
            bundled_reference(reference_id)
            if reference_id in _BUNDLED
            else self._user_reference(reference_id)
        )

    @staticmethod
    def _page(items: list[Json], offset: int, limit: int, key: str) -> Json:
        selected = items[offset : offset + limit]
        after = offset + len(selected)
        return {
            key: selected,
            "offset": offset,
            "total": len(items),
            "nextOffset": after if after < len(items) else None,
            "hasMore": after < len(items),
        }
