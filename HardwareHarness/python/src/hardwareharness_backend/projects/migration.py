"""One-time verified backup and v4 envelope conversion, without legacy Run readers."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import stat
from pathlib import Path

from hardwareharness_backend.compat import Record, json_parse
from hardwareharness_backend.contracts.projects import inspect_project_file
from hardwareharness_backend.storage import atomic_json


def _regular_directory(path: Path) -> None:
    if path.exists() and (
        path.is_symlink()
        or getattr(path.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ):
        raise ValueError("Legacy backup directories cannot be links")


def _durable(path: Path) -> None:
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())


def _hashes(root: Path) -> dict[str, str]:
    _regular_directory(root)
    result = {}
    for path in root.rglob("*"):
        _regular_directory(path)
        if path.is_file():
            result[path.relative_to(root).as_posix()] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    return result


def _prepare(path: Path, original: bytes) -> tuple[Path, Path]:
    digest = hashlib.sha256(original).hexdigest()
    backup = path.parent / "backups" / f"legacy-{digest[:24]}"
    _regular_directory(backup.parent)
    _regular_directory(backup)
    marker = backup / "conversion.json"
    runs = path.parent / "logs/runs"
    if not marker.exists():
        if backup.exists():
            raise ValueError("Incomplete legacy backup; original files were preserved")
        staging = backup.with_name(backup.name + ".pending")
        _regular_directory(staging)
        staging.mkdir(parents=True, exist_ok=True)
        staged_marker = staging / "conversion.json"
        # A crash after sealing but before rename can complete the existing transaction.
        if staged_marker.exists():
            staged = json.loads(staged_marker.read_text("utf-8"))
            hashes = _hashes(staging)
            hashes.pop("conversion.json", None)
            if hashes != staged["hashes"] or hashes.get("project.json") != digest:
                raise ValueError("Legacy backup verification failed")
            os.replace(staging, backup)
            return _prepare(path, original)
        (staging / "project.json").write_bytes(original)
        expected = {"project.json": digest}
        if runs.exists():
            if runs.is_symlink():
                raise ValueError("Legacy runs directory cannot be a link")
            entries = _hashes(runs)
            shutil.copytree(runs, staging / "runs", dirs_exist_ok=True)
            expected.update({"runs/" + name: value for name, value in entries.items()})
        if _hashes(staging) != expected:
            raise ValueError("Legacy backup verification failed")
        for name in expected:
            _durable(staging / name)
        (staging / "conversion.json").write_text(
            json.dumps({"hashes": expected, "phase": "backed_up"}), encoding="utf-8"
        )
        _durable(staging / "conversion.json")
        os.replace(staging, backup)
    state = json.loads(marker.read_text("utf-8"))
    actual = _hashes(backup)
    actual = {
        key: value
        for key, value in actual.items()
        if key != "conversion.json" and not key.startswith("retired-runs/")
    }
    if actual != state["hashes"] or actual.get("project.json") != digest:
        raise ValueError("Legacy backup verification failed")
    if runs.exists() and {"runs/" + key: value for key, value in _hashes(runs).items()} != {
        key: value for key, value in actual.items() if key.startswith("runs/")
    }:
        raise ValueError("Legacy runs changed after backup; conversion stopped")
    return backup, runs


async def convert_project(path: Path) -> Record:
    original = await asyncio.to_thread(path.read_bytes)
    raw = json_parse(original.decode("utf-8"))
    converted = inspect_project_file(raw)
    if raw["formatVersion"] == 4:
        return converted
    backup, runs = await asyncio.to_thread(_prepare, path, original)
    if runs.exists():
        await asyncio.to_thread(os.replace, runs, backup / "retired-runs")
    if await asyncio.to_thread(path.read_bytes) != original:
        raise ValueError("Project manifest changed during backup; original edit preserved")
    await atomic_json(path, converted)
    return converted
