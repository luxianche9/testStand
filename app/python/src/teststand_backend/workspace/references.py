"""Versioned, bounded documentation access without exposing the installed source tree."""

from __future__ import annotations

import hashlib
import json
import re
from importlib.resources import files
from pathlib import Path
from typing import Any

from teststand_backend import CONTRACT_REVISION
from teststand_backend import __version__ as app_version
from teststand_backend.contracts.errors import AppError
from teststand_backend.util import matches_terms, search_terms

from .files import MAX_FILE_BYTES, atomic_write, source_path

Json = dict[str, Any]
_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\Z")
_BUNDLED = {
    "ts-agent-interface": ("testStand public interface and recovery", "agent-interface.md"),
    "ts-device-plugin": ("Device plugin development guide (start here)", "plugin-guide.md"),
    "ts-plugin-sdk-api": ("Device plugin SDK API", "plugin-sdk-api.md"),
    "ts-plugin-streams": ("Device plugin streams (signals)", "plugin-streams.md"),
    "ts-plugin-vendor-bindings": (
        "Vendor driver bindings (ctypes, COM ports)",
        "plugin-vendor-bindings.md",
    ),
    "ts-plugin-contract": ("Device plugin contract", "plugin-contract.md"),
    "ts-plugin-checklist": ("Device plugin delivery checklist", "plugin-checklist.md"),
}


def versions() -> Json:
    return {
        "appVersion": app_version,
        "contractRevision": CONTRACT_REVISION,
    }


def bundled_reference(reference_id: str) -> Json:
    title, filename = _BUNDLED[reference_id]
    content = files(__package__).joinpath("templates", filename).read_text("utf-8")
    return {
        "referenceId": reference_id,
        "title": title,
        "origin": "bundled",
        "source": f"teststand:{reference_id}@{CONTRACT_REVISION}",
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
        path = source_path(self.root / ".teststand", "docs/references/index.json")
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
        path = source_path(self.root / ".teststand", f"docs/references/{digest}.txt")
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
        target = source_path(self.root / ".teststand", f"docs/references/{digest}.txt")
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
        terms = search_terms(query)
        # Sections holding every term; only when there is none anywhere, the closest ones.
        partial = bool(terms) and not any(
            _matching_lines(reference["content"], terms) for reference in references
        )
        for reference in references:
            for line_number, line in _matching_lines(reference["content"], terms, partial):
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


def _matching_lines(content: str, terms: list[str], partial: bool = False) -> list[tuple[int, str]]:
    """Numbered lines answering a query: without terms every line; otherwise, in each
    section (a Markdown heading up to the next) holding all terms, its heading and every
    line holding one of them, so a query finds words that are spread over a section.

    ``partial`` (no section anywhere holds all terms): the sections holding most of them,
    best first, so an agent's long query of synonyms still finds the section answering it."""
    lines = list(enumerate(content.splitlines(), 1))
    if not terms:
        return lines
    sections: list[list[tuple[int, str]]] = [[]]
    for numbered in lines:
        if numbered[1].lstrip().startswith("#") and sections[-1]:
            sections.append([])
        sections[-1].append(numbered)
    scored = []
    for position, section in enumerate(sections):
        text = "\n".join(line for _, line in section)
        score = sum(matches_terms([term], text) for term in terms)
        if score:
            scored.append((score, position, section))
    chosen = (
        sorted(scored, key=lambda item: (-item[0], item[1]))
        if partial
        else [item for item in scored if item[0] == len(terms)]
    )
    output: list[tuple[int, str]] = []
    for _, _, section in chosen:
        output.extend(
            (number, line)
            for index, (number, line) in enumerate(section)
            if (index == 0 and line.lstrip().startswith("#"))
            or any(matches_terms([term], line) for term in terms)
        )
    return output
