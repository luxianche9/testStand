from __future__ import annotations

import asyncio
import codecs
import io
import json
import mimetypes
import os
import secrets
import sys
import time
import uuid
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator, SchemaError, ValidationError

from hardwareharness_backend.contracts.errors import app_error, to_wire_error

from .logs import Json, RunLogStore, redact, safe_child, timestamp
from .processes import ProcessJob, terminate_tree

Invoke = Callable[[str, str, Json, int], Awaitable[Any]]
Acquire = Callable[[list[str], Json], Awaitable[Callable[[], None]]]
PythonProvider = Callable[[], Awaitable[str]]


@dataclass
class _Run:
    record: Json
    store: RunLogStore
    token: str
    release: Callable[[], None]
    process: asyncio.subprocess.Process | None = None
    job: ProcessJob | None = None
    monitor: asyncio.Task[None] | None = None
    cancellation: asyncio.Task[None] | None = None
    complete: Json | None = None
    cancelled: bool = False
    broken: bool = False
    started: float = field(default_factory=time.monotonic)
    calls: set[asyncio.Task[Any]] = field(default_factory=set)
    busy_hardware: set[str] = field(default_factory=set)
    occurrences: dict[tuple[str | None, str | None], int] = field(default_factory=dict)


class AutomationService:
    """Owns workflow state; root_provider returns the project root, not .hardwareharness."""

    def __init__(
        self,
        root_provider: Callable[[], str | None],
        invoke: Invoke | None = None,
        *,
        acquire: Acquire | None = None,
        python_provider: PythonProvider | None = None,
        notifier: Callable[[Json], None] | None = None,
        cancellation_timeout: float = 10.0,
    ) -> None:
        self.root_provider, self.invoke = root_provider, invoke
        self.acquire, self.python_provider = acquire, python_provider
        self.notifier, self.cancellation_timeout = notifier, cancellation_timeout
        self.active: dict[str, _Run] = {}
        self.server: asyncio.Server | None = None
        self.address = ""
        self.recovered: set[Path] = set()
        self._startup = asyncio.Lock()
        self._lifecycle = asyncio.Lock()
        self._closed = False

    def _ensure_open(self) -> None:
        if self._closed:
            raise app_error("unavailable", "Application execution service is closed")

    def _store(self) -> RunLogStore:
        root = self.root_provider()
        if root is None:
            raise app_error("requires_project", "Open a project before using applications")
        store = RunLogStore(root)
        if store.root not in self.recovered:
            store.recover(set(self.active))
            self.recovered.add(store.root)
        return store

    def _notify(self, value: Json) -> None:
        if self.notifier:
            self.notifier(redact(value))

    def _event(self, run: _Run, kind: str, data: Json, **identity: Any) -> Json:
        if run.broken:
            raise app_error("error", "Run logging failed; no further hardware calls are permitted")
        identity = {key: value for key, value in identity.items() if value is not None}
        if kind == "step.started":
            key = (identity.get("parentSpanId"), identity.get("name"))
            occurrence = run.occurrences.get(key, 0) + 1
            run.occurrences[key] = occurrence
            data = {**data, "occurrence": occurrence}
        try:
            event = run.store.append(
                run.record,
                kind,
                self._normalize_sources(run, self._scrub(run, data)),
                **self._scrub(run, identity),
            )
        except OSError:
            run.broken = True
            run.cancelled = True
            if run.cancellation is None:
                run.cancellation = asyncio.create_task(self._force_cancel(run))
            raise
        self._notify({"type": "runEvent", "event": event})
        return event

    @staticmethod
    def _scrub(run: _Run, value: Any) -> Any:
        if isinstance(value, str):
            return value.replace(run.token, "[REDACTED]")
        if isinstance(value, dict):
            return {key: AutomationService._scrub(run, item) for key, item in value.items()}
        if isinstance(value, list):
            return [AutomationService._scrub(run, item) for item in value]
        return value

    def _normalize_sources(self, run: _Run, value: Json) -> Json:
        result = dict(value)
        source = result.get("source")
        if isinstance(source, dict) and isinstance(source.get("path"), str):
            root = run.store.path(run.record["runId"]) / "source"
            candidate = Path(source["path"])
            if candidate.is_absolute() and candidate.is_relative_to(root):
                result["source"] = {**source, "path": candidate.relative_to(root).as_posix()}
        return result

    async def _listen(self) -> None:
        async with self._startup:
            if self.server is None:
                self.server = await asyncio.start_server(
                    self._connection, "127.0.0.1", 0, limit=32_768
                )
                port = self.server.sockets[0].getsockname()[1]
                self.address = f"127.0.0.1:{port}"

    async def start_run(self, raw: Json) -> Json:
        self._ensure_open()
        store = self._store()
        allowed = {
            "entrypoint",
            "inputs",
            "inputSchema",
            "hardwareIds",
            "name",
            "applicationId",
            "actionId",
        }
        if set(raw) - allowed:
            raise app_error("invalid_argument", "Unexpected workflow launch fields")
        for key in ("name", "applicationId", "actionId"):
            if key in raw and (not isinstance(raw[key], str) or (key == "name" and not raw[key])):
                raise app_error("invalid_argument", f"Invalid workflow {key}")
        entrypoint = raw.get("entrypoint")
        if not isinstance(entrypoint, str) or not entrypoint.endswith(".py"):
            raise app_error(
                "invalid_argument", "Workflow entrypoint must be a relative Python path"
            )
        try:
            source = safe_child(store.root / ".hardwareharness", entrypoint)
            if (
                Path(entrypoint).is_absolute()
                or ".." in Path(entrypoint).parts
                or not source.is_file()
            ):
                raise ValueError("Invalid path")
        except ValueError as error:
            raise app_error(
                "invalid_argument", "Workflow entrypoint must be an existing workspace file"
            ) from error
        inputs = raw.get("inputs", {})
        schema = raw.get("inputSchema", {"type": "object"})
        if not isinstance(inputs, dict) or not isinstance(schema, dict):
            raise app_error("invalid_argument", "Workflow inputs and inputSchema must be objects")
        hardware_ids = raw.get("hardwareIds", [])
        if not isinstance(hardware_ids, list) or not all(
            isinstance(item, str) and item for item in hardware_ids
        ):
            raise app_error("invalid_argument", "hardwareIds must be an array of non-empty strings")
        try:
            json.dumps(inputs, allow_nan=False)
            Draft202012Validator.check_schema(schema)
            Draft202012Validator(schema).validate(inputs)
        except (ValueError, TypeError, ValidationError, SchemaError) as error:
            raise app_error(
                "invalid_argument", f"Invalid workflow inputs or schema: {error}"
            ) from error
        record: Json = {
            "runId": f"run_{uuid.uuid4().hex}",
            "name": raw.get("name") or Path(entrypoint).stem,
            "entrypoint": Path(entrypoint).as_posix(),
            "inputs": inputs,
            "hardwareIds": sorted(set(hardware_ids)),
            "status": "running",
            "startedAt": timestamp(),
            "eventCount": 0,
            **{key: raw[key] for key in ("applicationId", "actionId") if key in raw},
        }
        python = await self.python_provider() if self.python_provider else sys.executable
        async with self._lifecycle:
            self._ensure_open()
            return await self._launch_run(store, record, inputs, python)

    async def _launch_run(
        self, store: RunLogStore, record: Json, inputs: Json, python: str
    ) -> Json:
        release = (
            await self.acquire(record["hardwareIds"], record) if self.acquire else lambda: None
        )
        if self._closed:
            release()
            self._ensure_open()
        run = _Run(record=record, store=store, token=secrets.token_urlsafe(32), release=release)
        self.active[record["runId"]] = run
        try:
            snapshot, hashes = store.snapshot(record["runId"])
            record.update(
                sourcePath=snapshot.relative_to(store.root).as_posix(),
                sourceHashes=hashes,
                pythonVersion="3.11",
                sdkVersion="0.1.0",
            )
            store.save(record)
            self._event(run, "run.started", {"entrypoint": record["entrypoint"], "inputs": inputs})
            await self._listen()
            self._ensure_open()
            env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("HARDWAREHARNESS_WORKER_")
            }
            # Development uses SDK sources; the installed project environment uses its wheel.
            sdk_source = str(Path(__file__).resolve().parents[2])
            if self.python_provider is None and (Path(sdk_source) / "hardwareharness").is_dir():
                env["PYTHONPATH"] = sdk_source
            env.update(
                HARDWAREHARNESS_WORKER_URL=f"http://{self.address}/rpc",
                HARDWAREHARNESS_WORKER_TOKEN=run.token,
                PYTHONIOENCODING="utf-8",
                PYTHONUTF8="1",
                PYTHONDONTWRITEBYTECODE="1",
            )
            options: Json = (
                {"creationflags": 0x08000200} if os.name == "nt" else {"start_new_session": True}
            )
            run.process = await asyncio.create_subprocess_exec(
                python,
                "-u",
                "-m",
                "hardwareharness._worker",
                cwd=snapshot,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **options,
            )
            run.job = ProcessJob(run.process.pid)
            self._ensure_open()
            assert run.process.stdin is not None
            run.process.stdin.write(
                json.dumps(
                    {
                        "entrypoint": record["entrypoint"],
                        "snapshot": str(snapshot),
                        "inputs": inputs,
                    },
                    allow_nan=False,
                ).encode("utf-8")
            )
            await run.process.stdin.drain()
            run.process.stdin.close()
            run.monitor = asyncio.create_task(self._monitor(run))
        except BaseException as error:
            if run.process:
                await terminate_tree(run.process, run.job)
            self.active.pop(record["runId"], None)
            release()
            record.update(status="failed", completedAt=timestamp(), error=to_wire_error(error))
            if not run.broken:
                self._event(run, "run.completed", {"status": "failed", "error": record["error"]})
            raise
        self._notify({"type": "run", "run": record})
        return cast(Json, redact(record))

    async def _monitor(self, run: _Run) -> None:
        assert run.process is not None

        async def output(stream: asyncio.StreamReader | None, kind: str) -> None:
            if stream is None:
                return
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            while data := await stream.read(8192):
                text = decoder.decode(data)
                if text and not run.broken:
                    self._event(run, kind, {"text": text})
            remainder = decoder.decode(b"", final=True)
            if remainder and not run.broken:
                self._event(run, kind, {"text": remainder})

        try:
            readers = [
                asyncio.create_task(output(run.process.stdout, "stdout")),
                asyncio.create_task(output(run.process.stderr, "stderr")),
            ]
            # Close the job on parent exit before draining inherited child output handles.
            while run.process.returncode is None:
                await asyncio.sleep(0.02)
            if run.job:
                run.job.close()
            await asyncio.gather(*readers, return_exceptions=True)
            completion = run.complete or {
                "status": "cancelled" if run.cancelled else "failed",
                "error": {
                    "category": "error",
                    "message": "Workflow process exited without a completion record "
                    f"(exit {run.process.returncode}); remote hardware result may be unknown",
                },
            }
            if run.broken:
                completion = {
                    "status": "failed",
                    "error": {
                        "category": "error",
                        "message": "Run logging failed; execution was stopped",
                    },
                }
            run.record.update(
                completion,
                completedAt=timestamp(),
                durationMs=round((time.monotonic() - run.started) * 1000),
            )
            if not run.broken:
                self._event(run, "run.completed", completion)
            else:
                run.store.save(run.record)
        finally:
            if run.cancellation:
                run.cancellation.cancel()
            if run.job:
                run.job.close()
            self.active.pop(run.record["runId"], None)
            run.release()
            self._notify({"type": "run", "run": run.record})

    async def _force_cancel(self, run: _Run) -> None:
        await asyncio.sleep(self.cancellation_timeout)
        if run.process and run.process.returncode is None:
            await terminate_tree(run.process, run.job)

    async def cancel_run(self, run_id: str) -> Json:
        run = self.active.get(run_id)
        if run is None:
            return cast(Json, (await self.get_run(run_id))["run"])
        if not run.cancelled:
            run.cancelled = True
            run.record["status"] = "cancelling"
            self._event(run, "run.cancelling", {"message": "Cancellation requested"})
            self._notify({"type": "run", "run": run.record})
            for task in list(run.calls):
                task.cancel()
            run.cancellation = asyncio.create_task(self._force_cancel(run))
        return cast(Json, redact(run.record))

    async def abort_hardware(self, hardware_id: str, message: str) -> None:
        runs = [run for run in self.active.values() if hardware_id in run.record["hardwareIds"]]
        for run in runs:
            self._event(
                run, "log", {"level": "error", "message": message, "hardwareId": hardware_id}
            )
            await self.cancel_run(run.record["runId"])

    async def get_run(self, run_id: str) -> Json:
        store = self._store()
        try:
            record = store.read(run_id)
        except FileNotFoundError as error:
            raise app_error("not_found", f"Unknown Run: {run_id}") from error
        events = store.events(run_id)
        return {
            "run": record,
            "events": events,
            "hasMore": bool(events and events[-1]["sequence"] < record["eventCount"]),
        }

    async def list_runs(self, query: Json | None = None) -> list[Json]:
        values = self._store().list()
        query = query or {}
        for key in ("status", "applicationId"):
            if query.get(key):
                values = [item for item in values if item.get(key) == query[key]]
        if query.get("statuses"):
            values = [item for item in values if item["status"] in query["statuses"]]
        if query.get("search"):
            term = str(query["search"]).casefold()
            values = [
                item
                for item in values
                if term
                in f"{item.get('name', '')} {item.get('entrypoint', '')} {item['runId']}".casefold()
            ]
        offset = max(0, int(query.get("offset", 0)))
        limit = max(1, min(10000, int(query.get("limit", 200))))
        return values[offset : offset + limit]

    async def run_events(self, run_id: str, after: int = 0, limit: int = 500) -> list[Json]:
        store = self._store()
        store.read(run_id)
        return store.events(run_id, max(0, after), max(1, min(5000, limit)))

    async def read_run_source(self, run_id: str, path: str) -> str:
        return safe_child(self._store().path(run_id) / "source", path).read_text(encoding="utf-8")

    async def read_run_attachment(self, run_id: str, path: str) -> Json:
        store = self._store()
        store.read(run_id)
        candidate = (store.root / path).resolve()
        artifact_root = safe_child(store.artifacts, run_id)
        if not candidate.is_relative_to(artifact_root) or not candidate.is_file():
            raise app_error("invalid_argument", "Attachment must belong to this Run")
        return {
            "content": candidate.read_bytes(),
            "name": candidate.name,
            "mediaType": mimetypes.guess_type(candidate.name)[0] or "application/octet-stream",
        }

    async def delete_run(self, run_id: str) -> None:
        if run_id in self.active:
            raise app_error("conflict", "Stop the Run before deleting it")
        self._store().delete(run_id)

    async def clear_completed_runs(self) -> Json:
        records = self._store().list()
        count = 0
        for record in records:
            if record["runId"] not in self.active:
                await self.delete_run(record["runId"])
                count += 1
        return {"deleted": count}

    async def export_run(self, run_id: str) -> bytes:
        store = self._store()
        store.read(run_id)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for directory, prefix in (
                (store.path(run_id), "run"),
                (safe_child(store.artifacts, run_id), "artifacts"),
            ):
                if directory.exists():
                    for path in directory.rglob("*"):
                        if path.is_file() and path.name != "launch.json":
                            archive.write(
                                path, f"{prefix}/{path.relative_to(directory).as_posix()}"
                            )
        return output.getvalue()

    async def close(self) -> None:
        self._closed = True
        async with self._lifecycle:
            await self._stop()

    async def _stop(self) -> None:
        runs = list(self.active.values())
        for run in runs:
            await self.cancel_run(run.record["runId"])
        await asyncio.gather(*(run.monitor for run in runs if run.monitor), return_exceptions=True)
        for run in runs:
            if run.cancellation:
                run.cancellation.cancel()
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        status, payload = 200, {}
        try:
            async with asyncio.timeout(10):
                header = await reader.readuntil(b"\r\n\r\n")
                lines = header.decode("ascii").split("\r\n")
                if lines[0] != "POST /rpc HTTP/1.1":
                    raise app_error("permission_denied", "Unknown worker endpoint")
                headers: dict[str, str] = {}
                for line in lines[1:]:
                    if line:
                        key, value = line.split(":", 1)
                        key = key.lower()
                        if key in headers:
                            raise ValueError("Duplicate header")
                        headers[key] = value.strip()
                if (
                    headers.get("host") != self.address
                    or "origin" in headers
                    or "transfer-encoding" in headers
                ):
                    raise app_error("permission_denied", "Invalid worker origin")
                credential = headers.get("authorization", "")
                run = next(
                    (
                        item
                        for item in self.active.values()
                        if secrets.compare_digest(credential, f"Bearer {item.token}")
                    ),
                    None,
                )
                if run is None:
                    raise app_error("permission_denied", "Invalid worker credential")
                length = int(headers.get("content-length", "0"))
                if length < 1 or length > 16 * 1024 * 1024:
                    raise app_error("invalid_argument", "Worker request exceeds the body limit")
                raw = json.loads(await reader.readexactly(length))
                if not isinstance(raw, dict) or not isinstance(raw.get("data"), dict):
                    raise ValueError("Invalid worker request")
            payload = {"result": await self._dispatch(run, raw.get("operation"), raw["data"])}
        except asyncio.CancelledError:
            payload, status = (
                {
                    "error": {
                        "category": "cancelled",
                        "message": "Hardware call cancelled; remote result may be unknown",
                    }
                },
                409,
            )
        except Exception as error:
            payload = {"error": to_wire_error(error)}
            status = 403 if getattr(error, "category", None) == "permission_denied" else 400
        try:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            writer.write(
                (
                    f"HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\n"
                    f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
                ).encode("ascii")
                + body
            )
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    async def _dispatch(self, run: _Run, operation: Any, data: Json) -> Any:
        if operation == "control":
            return {"cancelled": run.cancelled}
        if operation == "event":
            kind = data.get("type")
            if kind not in {
                "step.started",
                "step.completed",
                "log",
                "measurement",
                "stdout",
                "stderr",
            }:
                raise app_error("invalid_argument", "Invalid worker event type")
            return self._event(
                run,
                kind,
                data.get("data", {}),
                **{key: data[key] for key in ("spanId", "parentSpanId", "name") if key in data},
            )
        if operation == "attachment":
            item = run.store.attachment(run.record["runId"], Path(data["path"]), data.get("name"))
            item["mediaType"] = data.get("mediaType")
            self._event(run, "attachment", item, spanId=data.get("spanId"))
            return item
        if operation == "complete":
            if run.complete is not None or data.get("status") not in {
                "succeeded",
                "failed",
                "cancelled",
            }:
                raise app_error("invalid_argument", "Invalid workflow completion")
            run.complete = self._scrub(
                run, {key: data[key] for key in ("status", "result", "error") if key in data}
            )
            if run.cancelled and run.complete["status"] == "succeeded":
                run.complete["status"] = "cancelled"
            return None
        if operation != "call":
            raise app_error("permission_denied", "Worker API only permits hardware calls and logs")
        hardware_id, tool_name = data.get("hardwareId"), data.get("toolName")
        if not isinstance(hardware_id, str) or hardware_id not in run.record["hardwareIds"]:
            raise app_error(
                "permission_denied", f"Hardware {hardware_id} is not declared for this Run"
            )
        if not isinstance(tool_name, str) or not isinstance(data.get("arguments"), dict):
            raise app_error("invalid_argument", "Invalid hardware invocation")
        timeout = data.get("timeoutMs")
        if timeout is None:
            timeout = 30_000
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, int)
            or not 100 <= timeout <= 1_800_000
        ):
            raise app_error("invalid_argument", "timeout_ms must be an integer from 100 to 1800000")
        if self.invoke is None:
            raise app_error("unavailable", "No hardware execution adapter is configured")
        if run.complete is not None:
            raise app_error("conflict", "Run has already completed")
        if hardware_id in run.busy_hardware:
            raise app_error(
                "conflict", f"Hardware {hardware_id} already has an active call in this Run"
            )
        span_id = uuid.uuid4().hex
        identity = {"spanId": span_id, "parentSpanId": data.get("parentSpanId"), "name": tool_name}
        self._event(
            run,
            "hardware.started",
            {
                "hardwareId": hardware_id,
                "toolName": tool_name,
                "arguments": data["arguments"],
                "source": data.get("source", {}),
            },
            **identity,
        )
        started = time.monotonic()
        invoke = self.invoke

        async def execute() -> Any:
            return await invoke(hardware_id, tool_name, data["arguments"], timeout)

        task = asyncio.create_task(execute())
        run.calls.add(task)
        run.busy_hardware.add(hardware_id)
        try:
            try:
                output = await asyncio.wait_for(task, timeout / 1000)
            except TimeoutError as error:
                raise app_error(
                    "unavailable", "Hardware call timed out; remote operation result is unknown"
                ) from error
            encoded = json.dumps(output, ensure_ascii=False, allow_nan=False).encode("utf-8")
            logged_output = output
            if len(encoded) > 64 * 1024:
                path = run.store.path(run.record["runId"]) / f"output-{span_id}.json"
                path.write_bytes(
                    json.dumps(redact(self._scrub(run, output)), ensure_ascii=False).encode()
                )
                logged_output = {"attachment": run.store.attachment(run.record["runId"], path)}
                path.unlink()
            self._event(
                run,
                "hardware.completed",
                {
                    "status": "succeeded",
                    "output": logged_output,
                    "durationMs": round((time.monotonic() - started) * 1000),
                },
                **identity,
            )
            return output
        except BaseException as error:
            self._event(
                run,
                "hardware.completed",
                {
                    "status": "cancelled"
                    if isinstance(error, asyncio.CancelledError)
                    else "failed",
                    "error": to_wire_error(error),
                    "durationMs": round((time.monotonic() - started) * 1000),
                },
                **identity,
            )
            raise
        finally:
            run.calls.discard(task)
            run.busy_hardware.discard(hardware_id)
