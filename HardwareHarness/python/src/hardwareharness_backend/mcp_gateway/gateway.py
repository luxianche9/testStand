from __future__ import annotations

import asyncio
import errno
import hmac
import socket
from collections.abc import Callable
from typing import Any

import uvicorn
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http import StreamableHTTPServerTransport
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS as SDK_PROTOCOL_VERSIONS
from pydantic import ValidationError
from starlette.types import Receive, Scope, Send

from hardwareharness_backend.compat import (
    UNDEFINED,
    json_parse,
    json_stringify,
    new_uuid,
    utc_now_iso,
)
from hardwareharness_backend.contracts.validation import (
    literal,
    number,
    obj,
    record,
    string,
    union,
    unknown,
)

from .agent_instructions import AGENT_INSTRUCTIONS as AGENT_INSTRUCTIONS
from .redaction import redact
from .tool_registry import ToolRegistry

Record = dict[str, Any]
PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]
# The installed TS SDK supports this historical version in both client and server roles.
if "2024-10-07" not in SDK_PROTOCOL_VERSIONS:
    SDK_PROTOCOL_VERSIONS.append("2024-10-07")
_REQUEST_ID = union(string(), number(integer=True, finite=True))
_JSONRPC_MESSAGE = union(
    obj(
        {
            "jsonrpc": literal("2.0"),
            "id": _REQUEST_ID,
            "method": string(),
            "params": record(unknown()).optional(),
        },
        strict=True,
    ),
    obj(
        {"jsonrpc": literal("2.0"), "method": string(), "params": record(unknown()).optional()},
        strict=True,
    ),
    obj({"jsonrpc": literal("2.0"), "id": _REQUEST_ID, "result": record(unknown())}, strict=True),
    obj(
        {
            "jsonrpc": literal("2.0"),
            "id": _REQUEST_ID.optional(),
            "error": obj(
                {
                    "code": number(integer=True, finite=True),
                    "message": string(),
                    "data": unknown().optional(),
                }
            ),
        },
        strict=True,
    ),
)


class LocalMcpGateway:
    def __init__(
        self,
        application: Any,
        secrets: Any,
        preferred_port: int = 8000,
        request_context: Record | None = None,
    ) -> None:
        self.secrets = secrets
        self._request_context = request_context or {"actor": "agent", "source": "mcp"}
        self.registry = ToolRegistry(application)
        self.port = preferred_port
        self._active_token: str | None = None
        self._last_error: str | None = None
        self._last_client: Record | None = None
        self._server: uvicorn.Server | None = None
        self._server_task: asyncio.Task[None] | None = None
        self._sessions: dict[str, Record] = {}
        self._operations: set[asyncio.Task[Record]] = set()
        self._change_notifier: Callable[[], None] | None = None

    def set_change_notifier(self, callback: Callable[[], None]) -> None:
        self._change_notifier = callback

    def _changed(self) -> None:
        if self._change_notifier:
            self._change_notifier()

    def list_builtin_tools(self) -> list[Record]:
        return self.registry.list_builtin(self._request_context)

    def list_tools(self) -> list[Record]:
        return self.registry.list(self._request_context)

    async def invoke_tool(self, name: str, args: Record) -> Record:
        return await self.registry.invoke(self._request_context, name, args)

    def status(self) -> Record:
        return {
            "running": self._server is not None,
            "endpoint": f"http://127.0.0.1:{self.port}/mcp",
            "tokenConfigured": self._active_token is not None,
            "toolCount": len(self.list_tools()),
            **({"lastError": self._last_error} if self._last_error else {}),
            **({"lastClient": self._last_client} if self._last_client else {}),
        }

    def token(self) -> str:
        if not self._active_token:
            raise RuntimeError("Local MCP Gateway has not been initialized")
        return self._active_token

    async def rotate_token(self) -> str:
        import secrets

        token = secrets.token_urlsafe(32)
        await self.replace_token(token)
        return token

    async def replace_token(self, token: str) -> None:
        await self.secrets.set("gateway", {"token": token})
        self._active_token = token
        self._changed()

    async def start(self) -> None:
        if self._server:
            return
        if self._active_token is None:
            self._active_token = await self.secrets.ensure_token("gateway")
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        fallback = False
        try:
            try:
                listener.bind(("127.0.0.1", self.port))
            except OSError as error:
                if self.port and (
                    error.errno in {errno.EADDRINUSE, 10048}
                    or getattr(error, "winerror", None) == 10048
                ):
                    listener.close()
                    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    listener.bind(("127.0.0.1", 0))
                    fallback = True
                else:
                    raise
            listener.listen()
            listener.setblocking(False)
            self.port = listener.getsockname()[1]
            config = uvicorn.Config(
                self._handle_http,
                host="127.0.0.1",
                port=self.port,
                loop="asyncio",
                http="h11",
                ws="none",
                lifespan="off",
                interface="asgi3",
                log_config=None,
                access_log=False,
                log_level="critical",
            )
            server = uvicorn.Server(config)
            self._server_task = asyncio.create_task(server.serve(sockets=[listener]))
            while not server.started:
                if self._server_task.done():
                    self._server_task.result()
                    raise RuntimeError("Local MCP Gateway failed to start")
                await asyncio.sleep(0.001)
            self._server = server
            self._last_error = (
                f"Preferred Gateway port was occupied; using {self.port}" if fallback else None
            )
        except Exception as error:
            listener.close()
            self._last_error = str(error)
        self._changed()

    async def stop(self) -> None:
        sessions = list(self._sessions.values())
        self._sessions.clear()
        for session in sessions:
            session["stop"].set()
        await asyncio.gather(*(session["task"] for session in sessions), return_exceptions=True)
        server, self._server = self._server, None
        if server:
            server.should_exit = True
        if self._server_task:
            await self._server_task
            self._server_task = None
        self._changed()

    async def _handle_http(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        headers = {
            key.decode("latin1").lower(): value.decode("latin1")
            for key, value in scope.get("headers", [])
        }
        response_started = False

        async def tracked_send(message: Any) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            peer = scope.get("client")
            if (
                not peer
                or peer[0] not in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
                or headers.get("host") != f"127.0.0.1:{self.port}"
                or headers.get("origin")
                not in {None, f"http://127.0.0.1:{self.port}", f"https://127.0.0.1:{self.port}"}
            ):
                await _reply(tracked_send, 403, {"error": "local access only"})
                return
            authorization = headers.get("authorization", "")
            if not authorization.startswith("Bearer ") or not hmac.compare_digest(
                authorization[7:].encode("utf-8"), self.token().encode("utf-8")
            ):
                await _reply(tracked_send, 401, {"error": "unauthorized"})
                return
            if (
                scope["path"] != "/mcp"
                or scope.get("query_string")
                or scope["method"] not in {"GET", "POST", "DELETE"}
            ):
                await _reply(
                    tracked_send,
                    405,
                    {"error": "method not allowed"},
                    [(b"allow", b"GET, POST, DELETE")],
                )
                return
            data = b""
            body: Any = None
            if scope["method"] == "POST":
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    data += message.get("body", b"")
                    if len(data) > 1048576:
                        await _reply(tracked_send, 413, {"error": "request body too large"})
                        return
                    if not message.get("more_body", False):
                        break
                body = json_parse(data.decode("utf-8", errors="replace"))
                self._record_client(body)
            consumed = False

            async def replay_receive() -> Any:
                nonlocal consumed
                if not consumed:
                    consumed = True
                    return {"type": "http.request", "body": data, "more_body": False}
                return await receive()

            await self._handle_session(scope, replay_receive, tracked_send, headers, body)
        except Exception as error:
            self._last_error = str(error)
            self._changed()
            if not response_started:
                await _reply(tracked_send, 500, {"error": "internal error"})

    async def _handle_session(
        self, scope: Scope, receive: Receive, send: Send, headers: dict[str, str], body: Any
    ) -> None:
        session_id = headers.get("mcp-session-id")
        created = not session_id
        if session_id:
            session = self._sessions.get(session_id)
            if not session:
                await _reply(send, 404, {"error": "unknown MCP session"})
                return
        else:
            if scope["method"] != "POST" or not _is_initialize_request(body):
                await _reply(send, 400, {"error": "missing MCP session"})
                return
            session_id = new_uuid()
            session = await self._create_session(session_id, body)
        initialized = False

        async def session_send(message: Any) -> None:
            nonlocal initialized
            if created and message["type"] == "http.response.start" and message["status"] == 200:
                initialized = True
                self._sessions[session_id] = session
            await send(message)

        try:
            failure = _transport_error(scope["method"], headers, body, created)
            if failure:
                status, code, message = failure
                self._last_error = message
                self._changed()
                await _reply(
                    session_send,
                    status,
                    {
                        "jsonrpc": "2.0",
                        "error": {"code": code, "message": message},
                        "id": None,
                    },
                )
            elif isinstance(body, list):
                await self._handle_batch(scope, session_send, headers, session_id, body)
            elif (
                isinstance(body, dict)
                and "id" in body
                and "method" in body
                and body["method"] not in {"initialize", "ping", "tools/list", "tools/call"}
            ):
                await _sse_reply(
                    session_send,
                    session_id,
                    {
                        "jsonrpc": "2.0",
                        "id": body["id"],
                        "error": {"code": -32601, "message": "Method not found"},
                    },
                )
            else:
                await session["transport"].handle_request(scope, receive, session_send)
        except Exception:
            if created:
                self._sessions.pop(session_id, None)
                session["stop"].set()
                await session["task"]
            raise
        if (created and not initialized) or scope["method"] == "DELETE":
            self._sessions.pop(session_id, None)
            session["stop"].set()
            await session["task"]

    async def _handle_batch(
        self,
        scope: Scope,
        send: Send,
        headers: dict[str, str],
        session_id: str,
        messages: list[Record],
    ) -> None:
        has_requests = any("id" in message and "method" in message for message in messages)
        await send(
            {
                "type": "http.response.start",
                "status": 200 if has_requests else 202,
                "headers": _sse_headers(session_id) if has_requests else [],
            }
        )

        async def handle(message: Record) -> None:
            consumed = False

            async def receive() -> Any:
                nonlocal consumed
                if not consumed:
                    consumed = True
                    return {
                        "type": "http.request",
                        "body": json_stringify(message).encode(),
                        "more_body": False,
                    }
                await asyncio.Event().wait()

            async def message_send(part: Any) -> None:
                if has_requests and part["type"] == "http.response.body" and part.get("body"):
                    await send({**part, "more_body": True})

            await self._handle_session(scope, receive, message_send, headers, message)

        await asyncio.gather(*(handle(message) for message in messages))
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def _create_session(self, session_id: str, body: Record) -> Record:
        client = _client_info(body)
        name, version = client.get("name"), client.get("version")
        subject = (
            name + (f"@{version}" if isinstance(version, str) else "")
            if isinstance(name, str)
            else "unknown-mcp-client"
        )
        context = {**self._request_context, "requestId": new_uuid(), "subjectId": subject}
        protocol: Any = Server("hardwareharness", version="0.1.0", instructions=AGENT_INSTRUCTIONS)

        async def list_tools(_request: Any) -> Any:
            return types.ServerResult(
                types.EmptyResult.model_validate({"tools": self.registry.list(context)})
            )

        async def call_tool(request: Any) -> Any:
            try:
                # TS exposes cancellation as a signal that this handler does not use.
                # Cancelling the MCP request must not cancel the application operation.
                operation = asyncio.create_task(
                    self.registry.invoke(
                        context, request.params.name, request.params.arguments or {}
                    )
                )
                self._operations.add(operation)
                operation.add_done_callback(self._operation_finished)
                data = await asyncio.shield(operation)
                return types.ServerResult(
                    types.EmptyResult.model_validate(
                        {
                            "content": [{"type": "text", "text": json_stringify(data)}],
                            "structuredContent": data,
                        }
                    )
                )
            except Exception as error:
                details: Record = {
                    "category": getattr(error, "category", "error"),
                    "message": str(error),
                }
                recovery = getattr(error, "details", UNDEFINED)
                if recovery is not UNDEFINED:
                    details["details"] = redact(recovery)
                issues = getattr(error, "issues", None)
                if isinstance(issues, list):
                    details["category"] = "invalid_argument"
                    details["validationIssues"] = issues
                failure = {"ok": False, "error": details}
                return types.ServerResult(
                    types.EmptyResult.model_validate(
                        {
                            "isError": True,
                            "content": [{"type": "text", "text": json_stringify(failure)}],
                            "structuredContent": failure,
                        }
                    )
                )

        protocol.request_handlers[types.ListToolsRequest] = list_tools
        protocol.request_handlers[types.CallToolRequest] = call_tool
        transport = StreamableHTTPServerTransport(
            session_id,
            security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        )
        stop = asyncio.Event()
        ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def owner() -> None:
            try:
                async with transport.connect() as (read, write), asyncio.TaskGroup() as group:
                    initialization = protocol.create_initialization_options()
                    initialization.capabilities = types.ServerCapabilities(
                        tools=types.ToolsCapability()
                    )
                    running = group.create_task(protocol.run(read, write, initialization))
                    ready.set_result(None)
                    await stop.wait()
                    running.cancel()
            except BaseException as error:
                if not ready.done():
                    ready.set_exception(error)
                elif not isinstance(error, asyncio.CancelledError):
                    self._last_error = str(error)
                    self._changed()
            finally:
                self._sessions.pop(session_id, None)

        task = asyncio.create_task(owner())
        await ready
        return {"transport": transport, "protocol": protocol, "task": task, "stop": stop}

    def _operation_finished(self, task: asyncio.Task[Record]) -> None:
        self._operations.discard(task)
        if not task.cancelled():
            task.exception()

    def _record_client(self, body: Any) -> None:
        if not isinstance(body, dict) or body.get("method") != "initialize":
            return
        info = _client_info(body)
        name = info.get("name")
        if not isinstance(name, str) or name == "hardwareharness-integration-check":
            return
        self._last_client = {
            "name": name,
            "connectedAt": utc_now_iso(),
            **({"version": info["version"]} if isinstance(info.get("version"), str) else {}),
        }
        self._changed()


def _client_info(body: Record) -> Record:
    params = body.get("params")
    info = params.get("clientInfo") if isinstance(params, dict) else None
    return info if isinstance(info, dict) else {}


def _is_initialize_request(body: Any) -> bool:
    try:
        types.InitializeRequest.model_validate(body)
        return True
    except ValidationError:
        return False


def _transport_error(
    method: str, headers: dict[str, str], body: Any, created: bool
) -> tuple[int, int, str] | None:
    accept = headers.get("accept", "")
    if method == "GET" and "text/event-stream" not in accept:
        return 406, -32000, "Not Acceptable: Client must accept text/event-stream"
    if method == "POST":
        if "text/event-stream" not in accept or "application/json" not in accept:
            return (
                406,
                -32000,
                "Not Acceptable: Client must accept both application/json and text/event-stream",
            )
        if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            return 415, -32000, "Unsupported Media Type: Content-Type must be application/json"
        messages = body if isinstance(body, list) else [body]
        if any(not _JSONRPC_MESSAGE.safe_parse(message)["success"] for message in messages):
            return 400, -32700, "Parse error: Invalid JSON-RPC message"
        if any(_is_initialize_request(message) for message in messages):
            if not created:
                return 400, -32600, "Invalid Request: Server already initialized"
            if len(messages) > 1:
                return 400, -32600, "Invalid Request: Only one initialization request is allowed"
            return None
    version = headers.get("mcp-protocol-version")
    if version is not None and version not in PROTOCOL_VERSIONS:
        return (
            400,
            -32000,
            (
                f"Bad Request: Unsupported protocol version: {version} "
                f"(supported versions: {', '.join(PROTOCOL_VERSIONS)})"
            ),
        )
    return None


async def _sse_reply(send: Send, session_id: str, body: Record) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": _sse_headers(session_id),
        }
    )
    await send(
        {
            "type": "http.response.body",
            "body": f"event: message\ndata: {json_stringify(body)}\n\n".encode(),
        }
    )


def _sse_headers(session_id: str) -> list[tuple[bytes, bytes]]:
    return [
        (b"content-type", b"text/event-stream"),
        (b"cache-control", b"no-cache, no-transform"),
        (b"connection", b"keep-alive"),
        (b"x-accel-buffering", b"no"),
        (b"mcp-session-id", session_id.encode()),
    ]


async def _reply(
    send: Send, status: int, body: Any, extra_headers: list[tuple[bytes, bytes]] | None = None
) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), *(extra_headers or [])],
        }
    )
    await send({"type": "http.response.body", "body": json_stringify(body).encode("utf-8")})
