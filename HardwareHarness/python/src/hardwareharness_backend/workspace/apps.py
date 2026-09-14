from __future__ import annotations

import asyncio
import codecs
import contextlib
import json
import os
import re
import secrets
import socket
import subprocess
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import httpx
import jsonschema
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Route

from hardwareharness_backend.automation.processes import ProcessJob
from hardwareharness_backend.contracts.errors import AppError, to_wire_error

from .environment import EnvironmentManager
from .files import source_path

Record = dict[str, Any]
_TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
_APP_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\Z")
_RESERVED = {"con", "prn", "aux", "nul"} | {
    f"{prefix}{number}" for prefix in ("com", "lpt") for number in range(1, 10)
}


class Runner(Protocol):
    async def start_run(self, input: Record) -> Record: ...
    async def cancel_run(self, run_id: str) -> Record: ...
    async def get_run(self, run_id: str) -> Record: ...
    async def run_events(self, run_id: str, after: int = 0, limit: int = 500) -> list[Record]: ...


def validate_app_id(app_id: str) -> None:
    if not _APP_ID.fullmatch(app_id) or app_id.lower() in _RESERVED:
        raise AppError("invalid_argument", "Application ID must use letters, digits, '-' or '_'")


def _socket() -> socket.socket:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    return listener


async def terminate_tree(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(process.pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        await killer.wait()
    else:
        import signal

        with contextlib.suppress(ProcessLookupError):
            group_signal = "killpg"
            getattr(os, group_signal)(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        process.kill()
        await process.wait()


class AppsService:
    def __init__(self, root_path: str, runner: Runner, environment: EnvironmentManager) -> None:
        self.root = Path(root_path).resolve() / ".hardwareharness"
        self.runner = runner
        self.environment = environment
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._jobs: dict[str, ProcessJob] = {}
        self._gateways: dict[str, PreviewGateway] = {}
        self._states: dict[str, str] = {}
        self._tasks: dict[str, list[asyncio.Task[None]]] = {}
        self._run_ids: dict[str, set[str]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._sequences: dict[str, int] = {}
        self._closed = False
        self._errors: dict[str, str] = {}

    @property
    def busy(self) -> bool:
        return any(state in {"running", "starting"} for state in self._states.values())

    def list_apps(self) -> list[Record]:
        directory = self.root / "apps"
        if not directory.exists():
            return []
        result: list[Record] = []
        for path in sorted(directory.iterdir()):
            if not path.is_dir() or not (path / "app.json").is_file():
                continue
            try:
                result.append(self.status(path.name))
            except (AppError, OSError, ValueError) as error:
                result.append(
                    {
                        "id": path.name,
                        "name": path.name,
                        "actions": [],
                        "status": "failed",
                        "error": str(error),
                    }
                )
        return result

    def status(self, app_id: str) -> Record:
        manifest = self._manifest(app_id)
        result = {
            "id": app_id,
            "name": manifest["name"],
            "actions": manifest["actions"],
            "status": self._states.get(app_id, "stopped"),
        }
        gateway = self._gateways.get(app_id)
        if gateway is not None:
            result["previewUrl"] = gateway.preview_url
        if app_id in self._errors:
            result["error"] = self._errors[app_id]
        return result

    def create_app(self, app_id: str, name: str) -> Record:
        validate_app_id(app_id)
        if not name.strip():
            raise AppError("invalid_argument", "Application name is required")
        directory = source_path(self.root, f"apps/{app_id}", writable=True)
        workflow = source_path(self.root, f"workflows/{app_id}.py", writable=True)
        if directory.exists() or workflow.exists():
            raise AppError("conflict", "Application or workflow already exists")
        self.environment.scaffold(str(self.root.parent))
        directory.mkdir()
        (directory / "web").mkdir()
        template = Path(__file__).parent / "templates"
        manifest = {
            "name": name,
            "server": "server.py:app",
            "actions": [
                {
                    "id": "sample",
                    "name": "Run sample",
                    "entrypoint": f"workflows/{app_id}.py",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "samples": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 100,
                                "default": 3,
                            }
                        },
                        "additionalProperties": False,
                    },
                    "hardwareIds": [],
                }
            ],
        }
        for target, data in (
            (
                directory / "app.json",
                (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode(),
            ),
            (directory / "server.py", (template / "server.py.txt").read_bytes()),
            (directory / "web/index.html", (template / "index.html").read_bytes()),
            (workflow, (template / "workflow.py.txt").read_bytes()),
        ):
            with target.open("xb") as stream:
                stream.write(data)
        return self.status(app_id)

    async def start(self, app_id: str) -> Record:
        async with self._locks.setdefault(app_id, asyncio.Lock()):
            if self._closed:
                raise AppError("unavailable", "Application workspace has closed")
            if self._states.get(app_id) == "running":
                return self.status(app_id)
            manifest = self._manifest(app_id)
            self._errors.pop(app_id, None)
            try:
                python = await self.environment.python(str(self.root.parent))
                if self._closed:
                    raise AppError("unavailable", "Application workspace has closed")
                self._states[app_id] = "starting"
                server_file, attribute = str(manifest["server"]).split(":", 1)
                directory = source_path(self.root, f"apps/{app_id}")
                server = source_path(directory, server_file)
                if not server.is_file():
                    raise AppError("not_found", "Application server entrypoint does not exist")
                with _socket() as listener:
                    port = int(listener.getsockname()[1])
                env = {
                    key: value
                    for key, value in os.environ.items()
                    if not (
                        key.startswith("HARDWAREHARNESS_")
                        or key.startswith("HH_")
                        or key in {"PYTHONPATH", "PYTHONHOME"}
                    )
                }
                env.update({"PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"})
                process = await asyncio.create_subprocess_exec(
                    python,
                    "-m",
                    "uvicorn",
                    f"{server.stem}:{attribute}",
                    "--app-dir",
                    str(server.parent),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--no-access-log",
                    cwd=directory,
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                    start_new_session=os.name != "nt",
                )
                self._processes[app_id] = process
                self._jobs[app_id] = ProcessJob(process.pid)
                self._tasks[app_id] = [
                    asyncio.create_task(self._capture(app_id, process.stdout, "stdout")),
                    asyncio.create_task(self._capture(app_id, process.stderr, "stderr")),
                ]
                upstream = f"http://127.0.0.1:{port}"
                async with httpx.AsyncClient(trust_env=False) as client:
                    for _attempt in range(100):
                        if process.returncode is not None:
                            raise AppError(
                                "unavailable", "Application server exited during startup"
                            )
                        try:
                            await client.get(upstream, timeout=0.5)
                            break
                        except httpx.HTTPError:
                            await asyncio.sleep(0.1)
                    else:
                        raise AppError("unavailable", "Application server did not become ready")
                gateway = PreviewGateway(self, app_id, upstream, secrets.token_urlsafe(32))
                self._gateways[app_id] = gateway
                if app_id in self._errors:
                    raise AppError("unavailable", self._errors[app_id])
                await gateway.start()
                self._states[app_id] = "running"
                self._tasks[app_id].append(asyncio.create_task(self._watch(app_id, process)))
            except BaseException:
                await self._stop_process(app_id)
                self._states[app_id] = "failed"
                raise
        return self.status(app_id)

    async def stop(self, app_id: str) -> Record:
        validate_app_id(app_id)
        async with self._locks.setdefault(app_id, asyncio.Lock()):
            errors: list[Record] = []
            for run_id in self._run_ids.get(app_id, set()).copy():
                try:
                    await self.runner.cancel_run(run_id)
                    await self._wait_run(run_id)
                except (AppError, TimeoutError) as error:
                    errors.append({"runId": run_id, "message": str(error)})
            await self._stop_process(app_id)
            self._states[app_id] = "stopped"
            if errors:
                raise AppError("safe_stop_failed", "Some application runs did not stop", errors)
        return self.status(app_id)

    async def close(self) -> None:
        self._closed = True
        for app_id in set(self._processes) | set(self._run_ids) | set(self._locks):
            with contextlib.suppress(AppError):
                await self.stop(app_id)

    async def run_action(
        self, app_id: str, action_id: str, inputs: Record, *, require_running: bool = False
    ) -> Record:
        async with self._locks.setdefault(app_id, asyncio.Lock()):
            if self._closed:
                raise AppError("unavailable", "Application workspace has closed")
            if require_running and self._states.get(app_id) != "running":
                raise AppError("unavailable", "Application has stopped")
            return await self._run_action(app_id, action_id, inputs)

    async def _run_action(self, app_id: str, action_id: str, inputs: Record) -> Record:
        manifest = self._manifest(app_id)
        action = next((item for item in manifest["actions"] if item["id"] == action_id), None)
        if action is None:
            raise AppError("not_found", "Application action does not exist")
        try:
            jsonschema.validate(inputs, action["inputSchema"])
        except jsonschema.ValidationError as error:
            raise AppError("validation_failed", error.message) from error
        run = await self.runner.start_run(
            {
                "entrypoint": action["entrypoint"],
                "inputs": inputs,
                "inputSchema": action["inputSchema"],
                "hardwareIds": action["hardwareIds"],
                "applicationId": app_id,
                "actionId": action_id,
                "name": action["name"],
            }
        )
        self._run_ids.setdefault(app_id, set()).add(str(run["runId"]))
        return run

    def owns_run(self, app_id: str, run_id: str) -> bool:
        return run_id in self._run_ids.get(app_id, set())

    def logs(self, app_id: str, after: int = 0) -> list[Record]:
        validate_app_id(app_id)
        path = self.root / "logs/apps" / f"{app_id}.jsonl"
        if not path.exists():
            return []
        records: list[Record] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            with contextlib.suppress(json.JSONDecodeError):
                record = json.loads(line)
                if record["sequence"] > after:
                    records.append(record)
                    if len(records) == 500:
                        break
        return records

    async def _capture(self, app_id: str, stream: asyncio.StreamReader | None, name: str) -> None:
        try:
            await self._capture_output(app_id, stream, name)
        except OSError as error:
            self._errors[app_id] = f"Application output could not be recorded: {error}"
            self._states[app_id] = "failed"
            failure = asyncio.create_task(self._fail_app(app_id))
            self._tasks.setdefault(app_id, []).append(failure)

    async def _fail_app(self, app_id: str) -> None:
        async with self._locks.setdefault(app_id, asyncio.Lock()):
            for run_id in self._run_ids.get(app_id, set()).copy():
                with contextlib.suppress(AppError, TimeoutError):
                    await self.runner.cancel_run(run_id)
                    await self._wait_run(run_id)
            await self._stop_process(app_id)
            self._states[app_id] = "failed"

    async def _capture_output(
        self, app_id: str, stream: asyncio.StreamReader | None, name: str
    ) -> None:
        if stream is None:
            return
        path = self.root / "logs/apps" / f"{app_id}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        if app_id not in self._sequences:
            sequence = 0
            if path.exists():
                for line in path.read_text(encoding="utf-8").splitlines():
                    with contextlib.suppress(json.JSONDecodeError, KeyError):
                        sequence = max(sequence, int(json.loads(line)["sequence"]))
            self._sequences[app_id] = sequence
        while chunk := await stream.read(4096):
            # Both stream consumers serialize writes in the backend event loop.
            self._sequences[app_id] += 1
            sequence = self._sequences[app_id]
            event = {
                "sequence": sequence,
                "timestamp": datetime.now(UTC).isoformat(),
                "stream": name,
                "text": decoder.decode(chunk),
            }
            with path.open("ab") as destination:
                destination.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
                destination.flush()

    async def _watch(self, app_id: str, process: asyncio.subprocess.Process) -> None:
        await process.wait()
        job = self._jobs.pop(app_id, None)
        if job is not None:
            job.close()
        if self._states.get(app_id) == "running":
            self._states[app_id] = "failed"
            for run_id in self._run_ids.get(app_id, set()).copy():
                with contextlib.suppress(AppError, TimeoutError):
                    await self.runner.cancel_run(run_id)
                    await self._wait_run(run_id)
            gateway = self._gateways.pop(app_id, None)
            if gateway is not None:
                await gateway.close()

    async def _stop_process(self, app_id: str) -> None:
        self._states[app_id] = "stopped"
        gateway = self._gateways.pop(app_id, None)
        if gateway is not None:
            await gateway.close()
        process = self._processes.pop(app_id, None)
        job = self._jobs.pop(app_id, None)
        if job is not None:
            job.close()
        if process is not None:
            await terminate_tree(process)
        for task in self._tasks.pop(app_id, []):
            if task is not asyncio.current_task():
                if not task.done():
                    task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def _wait_run(self, run_id: str) -> None:
        async with asyncio.timeout(15):
            while True:
                detail = await self.runner.get_run(run_id)
                if detail["run"]["status"] in _TERMINAL:
                    return
                await asyncio.sleep(0.05)

    def _manifest(self, app_id: str) -> Record:
        validate_app_id(app_id)
        directory = source_path(self.root, f"apps/{app_id}")
        path = source_path(directory, "app.json")
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise AppError("not_found", "Application manifest does not exist") from error
        except (UnicodeError, json.JSONDecodeError) as error:
            raise AppError("validation_failed", "Application manifest is not valid JSON") from error
        if not isinstance(manifest, dict) or not isinstance(manifest.get("name"), str):
            raise AppError("validation_failed", "Application manifest requires a name")
        server = manifest.get("server", "server.py:app")
        if not isinstance(server, str) or not re.fullmatch(r"[^:]+\.py:[A-Za-z_]\w*", server):
            raise AppError("validation_failed", "Server must be a Python file and ASGI attribute")
        source_path(directory, server.split(":")[0])
        manifest["server"] = server
        actions = manifest.get("actions")
        if not isinstance(actions, list):
            raise AppError("validation_failed", "Application manifest requires actions")
        ids: set[str] = set()
        for action in actions:
            if not isinstance(action, dict) or not isinstance(action.get("id"), str):
                raise AppError("validation_failed", "Action requires an ID")
            validate_app_id(action["id"])
            if action["id"] in ids:
                raise AppError("validation_failed", "Duplicate action ID")
            ids.add(action["id"])
            entrypoint = action.get("entrypoint")
            if not isinstance(entrypoint, str) or not entrypoint.endswith(".py"):
                raise AppError("validation_failed", "Action requires a Python entrypoint")
            source_path(self.root, entrypoint)
            schema = action.get("inputSchema", {"type": "object"})
            try:
                jsonschema.Draft202012Validator.check_schema(schema)
            except jsonschema.SchemaError as error:
                raise AppError("validation_failed", "Invalid action input schema") from error
            hardware = action.get("hardwareIds", [])
            if not isinstance(hardware, list) or any(
                not isinstance(item, str) for item in hardware
            ):
                raise AppError("validation_failed", "hardwareIds must be an array of strings")
            action.update(
                {
                    "name": action.get("name", action["id"]),
                    "inputSchema": schema,
                    "hardwareIds": hardware,
                }
            )
        return manifest


class PreviewGateway:
    """A separate origin per app; browser credentials never authorize worker hardware calls."""

    def __init__(self, service: AppsService, app_id: str, upstream: str, ticket: str) -> None:
        self.service, self.app_id, self.upstream, self.ticket = service, app_id, upstream, ticket
        self.cookie = secrets.token_urlsafe(32)
        self.cookie_name = "hh-preview-" + secrets.token_hex(8)
        self.authority = ""
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self._listener: socket.socket | None = None
        self._client = httpx.AsyncClient(trust_env=False, timeout=30)
        self.app = Starlette(
            routes=[
                Route(
                    "/{path:path}",
                    self.handle,
                    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
                )
            ]
        )

    @property
    def preview_url(self) -> str:
        return f"http://{self.authority}/?ticket={self.ticket}"

    async def start(self) -> None:
        self._listener = _socket()
        self.authority = f"localhost:{self._listener.getsockname()[1]}"
        self._server = uvicorn.Server(
            uvicorn.Config(
                self.app,
                host="127.0.0.1",
                port=0,
                log_config=None,
                access_log=False,
                lifespan="off",
                log_level="warning",
            )
        )
        self._task = asyncio.create_task(self._server.serve(sockets=[self._listener]))
        for _attempt in range(100):
            if self._server.started:
                return
            if self._task.done():
                await self._task
                raise AppError("unavailable", "Preview server exited during startup")
            await asyncio.sleep(0.01)
        raise AppError("unavailable", "Preview server did not become ready")

    async def close(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, 5)
            except TimeoutError:
                self._task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._task
            except Exception:
                # Startup errors already reach the caller; cleanup must still release the socket.
                pass
        if self._listener is not None:
            self._listener.close()
        await self._client.aclose()

    async def handle(self, request: Request) -> Response:
        response: Response
        if request.headers.get("host") != self.authority:
            return JSONResponse({"error": "Invalid preview Host"}, status_code=403)
        origin = request.headers.get("origin")
        expected_origin = f"http://{self.authority}"
        if origin is not None and origin != expected_origin:
            return JSONResponse({"error": "Invalid preview Origin"}, status_code=403)
        if request.method not in {"GET", "HEAD"} and origin != expected_origin:
            return JSONResponse({"error": "Preview Origin required"}, status_code=403)
        ticket = request.query_params.get("ticket", "")
        if request.method == "GET" and ticket and secrets.compare_digest(ticket, self.ticket):
            response = RedirectResponse("/", status_code=303)
            response.set_cookie(
                self.cookie_name, self.cookie, httponly=True, samesite="none", secure=True, path="/"
            )
            # Chromium treats localhost as trustworthy; CHIPS permits this cookie in the
            # desktop's cross-site iframe without exposing it to other top-level sites.
            response.headers["set-cookie"] += "; Partitioned"
            response.headers["Referrer-Policy"] = "no-referrer"
            return response
        if not secrets.compare_digest(request.cookies.get(self.cookie_name, ""), self.cookie):
            return JSONResponse({"error": "Preview authentication required"}, status_code=401)
        try:
            if request.url.path.startswith("/__hardwareharness/"):
                response = await self._action_api(request)
            else:
                response = await self._proxy(request)
        except AppError as error:
            response = JSONResponse(
                to_wire_error(error),
                status_code={
                    "not_found": 404,
                    "permission_denied": 403,
                    "conflict": 409,
                    "occupancy_required": 409,
                    "validation_failed": 422,
                }.get(error.category, 400),
            )
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    async def _action_api(self, request: Request) -> Response:
        parts = request.url.path.removeprefix("/__hardwareharness/").split("/")
        if len(parts) == 2 and parts[0] == "actions" and request.method == "POST":
            body = await self._body(request)
            try:
                inputs = json.loads(body)
            except (json.JSONDecodeError, UnicodeError) as error:
                raise AppError("invalid_argument", "Action input must be JSON") from error
            if not isinstance(inputs, dict):
                raise AppError("invalid_argument", "Action input must be an object")
            return JSONResponse(
                await self.service.run_action(self.app_id, parts[1], inputs, require_running=True)
            )
        if len(parts) in {2, 3} and parts[0] == "runs":
            run_id = parts[1]
            if not self.service.owns_run(self.app_id, run_id):
                raise AppError("not_found", "Run does not belong to this application session")
            if len(parts) == 2 and request.method == "GET":
                return JSONResponse(await self.service.runner.get_run(run_id))
            if len(parts) == 3 and parts[2] == "cancel" and request.method == "POST":
                return JSONResponse(await self.service.runner.cancel_run(run_id))
            if len(parts) == 3 and parts[2] == "events" and request.method == "GET":
                try:
                    after = int(
                        request.headers.get("last-event-id", request.query_params.get("after", "0"))
                    )
                except ValueError as error:
                    raise AppError("invalid_argument", "Event cursor must be an integer") from error
                return StreamingResponse(
                    self._events(run_id, after), media_type="text/event-stream"
                )
        raise AppError("not_found", "Unknown application operation")

    async def _events(self, run_id: str, after: int) -> AsyncIterator[str]:
        while True:
            events = await self.service.runner.run_events(run_id, after=after)
            for event in events:
                after = int(event["sequence"])
                yield f"id: {after}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            if events:
                continue
            detail = await self.service.runner.get_run(run_id)
            if detail["run"]["status"] in _TERMINAL:
                # Completion can be persisted between the empty page and the status read.
                if after < detail["run"].get("eventCount", after):
                    continue
                yield "event: complete\ndata: {}\n\n"
                return
            yield ": heartbeat\n\n"
            await asyncio.sleep(0.25)

    async def _proxy(self, request: Request) -> Response:
        path = request.url.path
        query = request.url.query
        url = self.upstream + path + (f"?{query}" if query else "")
        body = await self._body(request)
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "cookie", "authorization", "connection"}
        }
        try:
            upstream = await self._client.request(
                request.method, url, content=body, headers=headers
            )
        except httpx.HTTPError as error:
            raise AppError("unavailable", "Application server is unavailable") from error
        safe_headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower()
            not in {
                "set-cookie",
                "content-length",
                "content-encoding",
                "transfer-encoding",
                "connection",
            }
        }
        # A redirect from user code cannot navigate the preview into desktop or remote origins.
        location = safe_headers.get("location")
        if location is not None and ("://" in location or location.startswith("//")):
            safe_headers.pop("location")
            return JSONResponse({"error": "External preview redirect refused"}, status_code=403)
        return Response(upstream.content, status_code=upstream.status_code, headers=safe_headers)

    @staticmethod
    async def _body(request: Request) -> bytes:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 10 * 1024 * 1024:
                raise AppError("invalid_argument", "Application request exceeds 10 MiB")
        return bytes(body)
