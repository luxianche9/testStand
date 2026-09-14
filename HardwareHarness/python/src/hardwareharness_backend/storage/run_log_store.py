import asyncio
import math
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import cmp_to_key
from pathlib import Path
from typing import Any
from urllib.parse import quote

from hardwareharness_backend.compat import (
    UNDEFINED,
    Record,
    js_strict_equal,
    js_string,
    js_trim,
    json_parse,
    json_stringify,
)
from hardwareharness_backend.compat.filesystem import (
    fs_operation,
    mkdir,
    read_bytes,
    rm,
    scandir,
    stat,
)
from hardwareharness_backend.contracts.orchestration import (
    parse_test_node_run,
    parse_test_run,
    parse_test_run_event,
    parse_test_run_execution_snapshot,
    parse_test_run_log_archive,
)
from hardwareharness_backend.storage.file_storage import (
    atomic_json,
    atomic_text,
    read_json,
    sync_directory,
)


@dataclass
class RunLogStoreOptions:
    compact_after_bytes: int = 512 * 1024
    on_write: Callable[[Record], None] | None = None


class ProjectRunLogStore:
    def __init__(self, options: RunLogStoreOptions | Record | None = None) -> None:
        if isinstance(options, RunLogStoreOptions):
            limit: Any = options.compact_after_bytes
            self._on_write = options.on_write
        else:
            config = options or {}
            limit = config.get("compactAfterBytes")
            self._on_write = config.get("onWrite")
        self._compact_after_bytes = (
            int(limit)
            if isinstance(limit, (int, float))
            and not isinstance(limit, bool)
            and math.isfinite(limit)
            and limit > 0
            and limit == int(limit)
            else 512 * 1024
        )
        self._operations: dict[str, asyncio.Task[None]] = {}

    async def load(self, root_path: str | Path) -> Record:
        await asyncio.gather(*self._operations.values(), return_exceptions=True)
        directory = run_directory(root_path)
        try:
            entries = scandir(directory)
        except FileNotFoundError:
            return {"archives": [], "snapshots": [], "warnings": []}
        from hardwareharness_backend.compat.collation import locale_compare

        def compare_path(a: Path, b: Path) -> int:
            return locale_compare(a.name, b.name)

        order = cmp_to_key(compare_path)
        archives: list[Record] = []
        snapshots: list[Record] = []
        warnings: list[str] = []
        loaded_ids: set[str] = set()
        for entry in sorted(
            (item for item in entries if item.is_dir() and not item.is_symlink()), key=order
        ):
            loaded = await self._load_run_directory(entry, entry.name)
            warnings.extend(loaded["warnings"])
            if "archive" in loaded:
                archives.append(loaded["archive"])
                loaded_ids.add(loaded["archive"]["run"]["runId"])
            if "executionSnapshot" in loaded:
                snapshots.append(loaded["executionSnapshot"])
        for entry in sorted(
            (
                item
                for item in entries
                if item.is_file() and not item.is_symlink() and item.name.endswith(".json")
            ),
            key=order,
        ):
            try:
                archive = parse_test_run_log_archive(await read_json(entry))
                run_id = archive["run"]["runId"]
                if run_id in loaded_ids:
                    warnings.append(
                        f"{entry.name}: ignored legacy archive because a JSONL Run exists"
                    )
                    continue
                archives.append(archive)
                loaded_ids.add(run_id)
                try:
                    await self._migrate_legacy(root_path, entry.name, archive)
                except Exception as error:
                    warnings.append(f"{entry.name}: failed to migrate legacy archive: {error}")
            except Exception as error:
                warnings.append(f"{entry.name}: {error}")
        return {"archives": archives, "snapshots": snapshots, "warnings": warnings}

    async def upsert_run(self, root_path: str | Path, run: Record) -> None:
        parsed = parse_test_run(run)
        await self._enqueue(
            root_path,
            parsed["runId"],
            lambda: self._append_record(
                root_path,
                parsed["runId"],
                {"formatVersion": 1, "type": "run.upsert", "run": parsed},
            ),
        )

    async def upsert_node_run(self, root_path: str | Path, node_run: Record) -> None:
        parsed = parse_test_node_run(node_run)
        await self._enqueue(
            root_path,
            parsed["runId"],
            lambda: self._append_record(
                root_path,
                parsed["runId"],
                {"formatVersion": 1, "type": "nodeRun.upsert", "nodeRun": parsed},
            ),
        )

    async def append_events(self, root_path: str | Path, run_id: str, events: list[Record]) -> None:
        if not events:
            return
        parsed = [parse_test_run_event(event) for event in events]
        if any(event["runId"] != run_id for event in parsed):
            raise RuntimeError(f"Event Run id does not match {run_id}")
        await self._enqueue(
            root_path,
            run_id,
            lambda: self._append_record(
                root_path,
                run_id,
                {"formatVersion": 1, "type": "events.append", "runId": run_id, "events": parsed},
            ),
        )

    async def upsert_execution_snapshot(self, root_path: str | Path, snapshot: Record) -> None:
        parsed = parse_test_run_execution_snapshot(snapshot)
        await self._enqueue(
            root_path,
            parsed["runId"],
            lambda: self._append_record(
                root_path,
                parsed["runId"],
                {"formatVersion": 1, "type": "execution.snapshot", "snapshot": parsed},
            ),
        )

    async def remove(self, root_path: str | Path, run_id: str) -> None:
        directory = run_path(root_path, run_id)

        async def operation() -> None:
            def delete() -> None:
                rm(directory, recursive=True, force=True)
                rm(run_directory(root_path) / f"{safe_segment(run_id)}.json", force=True)

            await asyncio.to_thread(delete)
            await sync_directory(run_directory(root_path))

        await self._enqueue(root_path, run_id, operation)

    async def clear(self, root_path: str | Path, run_ids: list[str]) -> None:
        for run_id in run_ids:
            await self.remove(root_path, run_id)

    async def _append_record(self, root_path: str | Path, run_id: str, record: Record) -> None:
        directory = run_path(root_path, run_id)
        data = (json_stringify(record) + "\n").encode("utf-8")

        def append() -> int:
            mkdir(directory)
            path = directory / "run.jsonl"
            with fs_operation("open", path), path.open("ab") as handle:
                with fs_operation("write"):
                    handle.write(data)
                    handle.flush()
                with fs_operation("fsync"):
                    os.fsync(handle.fileno())
            return stat(path).st_size

        size = await asyncio.to_thread(append)
        if self._on_write:
            self._on_write({"kind": "append", "bytes": len(data)})
        if size >= self._compact_after_bytes:
            await self._compact(directory)

    async def _compact(self, directory: Path) -> None:
        loaded = await self._load_run_directory(directory, str(directory))
        if "archive" not in loaded or loaded["warnings"]:
            return
        snapshot = {"formatVersion": 1, "archive": loaded["archive"]}
        if "executionSnapshot" in loaded:
            snapshot["executionSnapshot"] = loaded["executionSnapshot"]
        text = json_stringify(snapshot, 2) + "\n"
        await atomic_text(directory / "snapshot.json", text)
        if self._on_write:
            self._on_write({"kind": "snapshot", "bytes": len(text.encode("utf-8"))})
        await atomic_text(directory / "run.jsonl", "")

    async def _load_run_directory(self, directory: Path, label: str) -> Record:
        warnings: list[str] = []
        run: Record | None = None
        nodes: dict[str, Record] = {}
        node_order: list[str] = []
        events: dict[int, Record] = {}
        execution_snapshot: Record | None = None
        try:
            raw = await read_json(directory / "snapshot.json")
            if raw is not UNDEFINED:
                snapshot = parse_snapshot(raw)
                run = snapshot["archive"]["run"]
                execution_snapshot = snapshot.get("executionSnapshot")
                nodes = {node["nodeRunId"]: node for node in snapshot["archive"]["nodeRuns"]}
                node_order = [node["nodeRunId"] for node in snapshot["archive"]["nodeRuns"]]
                events = {event["eventId"]: event for event in snapshot["archive"]["events"]}
        except Exception as error:
            warnings.append(f"{label}/snapshot.json: {error}")
        log = ""
        try:
            data = await asyncio.to_thread(read_bytes, directory / "run.jsonl")
            log = data.decode("utf-8", "replace")
        except FileNotFoundError:
            pass
        except OSError as error:
            warnings.append(f"{label}/run.jsonl: {error}")
        for index, line in enumerate(log.split("\n")):
            if not js_trim(line):
                continue
            try:
                record = parse_record(json_parse(line))
                if record["type"] == "run.upsert":
                    run = record["run"]
                elif record["type"] == "nodeRun.upsert":
                    node = record["nodeRun"]
                    if node["nodeRunId"] not in nodes:
                        node_order.append(node["nodeRunId"])
                    nodes[node["nodeRunId"]] = node
                elif record["type"] == "events.append":
                    for event in record["events"]:
                        events[event["eventId"]] = event
                else:
                    execution_snapshot = record["snapshot"]
            except Exception as error:
                warnings.append(f"{label}/run.jsonl:{index + 1}: {error}")
        if run is None:
            if js_trim(log) or warnings:
                warnings.append(f"{label}: Run log does not contain a Run record")
            return {"warnings": warnings}
        try:
            archive = parse_test_run_log_archive(
                {
                    "formatVersion": 1,
                    "run": run,
                    "nodeRuns": [nodes[node_id] for node_id in node_order],
                    "events": [events[key] for key in sorted(events)],
                }
            )
            result: Record = {"archive": archive, "warnings": warnings}
            if execution_snapshot is not None:
                result["executionSnapshot"] = execution_snapshot
            return result
        except Exception as error:
            warnings.append(f"{label}: {error}")
            return {"warnings": warnings}

    async def _migrate_legacy(self, root_path: str | Path, name: str, archive: Record) -> None:
        directory = run_path(root_path, archive["run"]["runId"])
        await asyncio.to_thread(mkdir, directory)
        await atomic_json(directory / "snapshot.json", {"formatVersion": 1, "archive": archive})
        await atomic_text(directory / "run.jsonl", "")
        await asyncio.to_thread(rm, run_directory(root_path) / name, force=True)
        await sync_directory(run_directory(root_path))

    async def _enqueue(
        self, root_path: str | Path, run_id: str, operation: Callable[[], Awaitable[None]]
    ) -> None:
        key = f"{root_path}\0{run_id}"
        previous = self._operations.get(key)

        async def execute() -> None:
            if previous is not None:
                await asyncio.gather(previous, return_exceptions=True)
            await operation()

        current = asyncio.create_task(execute())
        self._operations[key] = current
        try:
            await asyncio.shield(current)
        finally:
            if current.done() and self._operations.get(key) is current:
                del self._operations[key]


def parse_snapshot(raw: Any) -> Record:
    if not isinstance(raw, dict) or not js_strict_equal(raw.get("formatVersion"), 1):
        raise RuntimeError("Unsupported snapshot formatVersion")
    result = {
        "formatVersion": 1,
        "archive": parse_test_run_log_archive(raw.get("archive", UNDEFINED)),
    }
    if raw.get("executionSnapshot", UNDEFINED) is not UNDEFINED:
        result["executionSnapshot"] = parse_test_run_execution_snapshot(raw["executionSnapshot"])
    return result


def parse_record(raw: Any) -> Record:
    if not isinstance(raw, (dict, list)):
        raise RuntimeError("Run log record must be an object")
    value = raw if isinstance(raw, dict) else {}
    if not js_strict_equal(value.get("formatVersion", UNDEFINED), 1):
        version = js_string(value.get("formatVersion", UNDEFINED))
        raise RuntimeError(f"Unsupported Run log record formatVersion: {version}")
    kind = value.get("type", UNDEFINED)
    if kind == "run.upsert":
        return {
            "formatVersion": 1,
            "type": kind,
            "run": parse_test_run(value.get("run", UNDEFINED)),
        }
    if kind == "nodeRun.upsert":
        return {
            "formatVersion": 1,
            "type": kind,
            "nodeRun": parse_test_node_run(value.get("nodeRun", UNDEFINED)),
        }
    if kind == "execution.snapshot":
        return {
            "formatVersion": 1,
            "type": kind,
            "snapshot": parse_test_run_execution_snapshot(value.get("snapshot", UNDEFINED)),
        }
    if kind == "events.append":
        if not isinstance(value.get("runId"), str) or not isinstance(value.get("events"), list):
            raise RuntimeError("Invalid events.append record")
        events = [parse_test_run_event(event) for event in value["events"]]
        if any(event["runId"] != value["runId"] for event in events):
            raise RuntimeError("Event Run id does not match record Run id")
        return {"formatVersion": 1, "type": kind, "runId": value["runId"], "events": events}
    raise RuntimeError(f"Unknown Run log record type: {js_string(kind)}")


def run_directory(root_path: str | Path) -> Path:
    return Path(root_path) / ".hardwareharness" / "logs" / "runs"


def safe_segment(value: str) -> str:
    if value in ("", ".", ".."):
        raise ValueError(f"Invalid Run id: {value}")
    return quote(value, safe="~!.'()-")


def run_path(root_path: str | Path, run_id: str) -> Path:
    return run_directory(root_path) / safe_segment(run_id)
