from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, suppress
from datetime import timedelta
from typing import Any

import httpx
from jsonschema import Draft7Validator
from mcp import ClientSession, types

from hardwareharness_backend.compat import clone, json_stringify
from hardwareharness_backend.contracts.devices import (
    parse_managed_hardware,
    parse_reported_managed_hardware,
)
from hardwareharness_backend.contracts.errors import app_error

from .mcp_transport import compatible_http_client
from .schema_validation import schema_error

Record = dict[str, Any]


class McpCompatibilityError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"MCP error {code}: {message}")
        self.code, self.data = code, data


class _ClientAdapter:
    """Pin the SDK boundary: TS callTool validation and cancellation differ from Python's."""

    def __init__(
        self, session: ClientSession, output_schemas: dict[str, Record], required_tasks: set[str]
    ) -> None:
        self.session = session
        self.output_schemas = output_schemas
        self.required_tasks = required_tasks

    async def call_tool(
        self,
        name: str,
        arguments: Record,
        *,
        meta: Record | None = None,
        options: Record | None = None,
    ) -> Record:
        options = options or {}
        if name in self.required_tasks:
            raise McpCompatibilityError(
                -32600,
                f'Tool "{name}" requires task-based execution. '
                "Use client.experimental.tasks.callToolStream() instead.",
            )
        signal = options.get("signal")
        if signal and signal.aborted:
            raise signal.reason or McpCompatibilityError(-32001, "Request cancelled")
        request = types.ClientRequest(
            types.CallToolRequest(
                params=types.CallToolRequestParams(
                    name=name,
                    arguments=arguments,
                    _meta=types.RequestParams.Meta(**meta) if meta else None,
                )
            )
        )
        request_ids: list[int] = []

        async def invoke() -> types.CallToolResult:
            # SDK 1.29.1 increments this counter synchronously at send_request entry.
            # Capture before awaiting so concurrent calls retain their own cancellation id.
            request_ids.append(self.session._request_id)
            return await self.session.send_request(request, types.CallToolResult)

        task = asyncio.create_task(invoke())
        abort = asyncio.create_task(signal.wait()) if signal else None
        timeout_ms = options.get("timeout", 60000)
        try:
            pending = [task] if abort is None else [task, abort]
            done, _ = await asyncio.wait(
                pending, timeout=timeout_ms / 1000, return_when=asyncio.FIRST_COMPLETED
            )
            if task not in done:
                reason = signal.reason if signal and signal.aborted else None
                failure = reason or McpCompatibilityError(
                    -32001, "Request timed out", {"timeout": timeout_ms}
                )
                if request_ids:
                    await self.session.send_notification(
                        types.ClientNotification(
                            types.CancelledNotification(
                                params=types.CancelledNotificationParams(
                                    requestId=request_ids[0], reason=str(failure)
                                )
                            )
                        )
                    )
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise failure
            result = task.result().model_dump(by_alias=True, exclude_none=True)
        finally:
            if abort:
                abort.cancel()
                await asyncio.gather(abort, return_exceptions=True)
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        output_schema = self.output_schemas.get(name)
        if output_schema:
            structured = result.get("structuredContent")
            if structured is None and not result.get("isError"):
                raise McpCompatibilityError(
                    -32600,
                    f"Tool {name} has an output schema but did not return structured content",
                )
            if structured is not None:
                failure_text = schema_error(output_schema, structured, validate_formats=True)
                if failure_text:
                    raise McpCompatibilityError(
                        -32602,
                        "Structured content does not match the "
                        f"tool's output schema: {failure_text}",
                    )
        return result


class McpHttpTransport:
    kind = "mcp-http"

    def __init__(self, secrets: Any) -> None:
        self.secrets = secrets
        self.sessions: dict[str, Record] = {}
        self._connecting: dict[str, asyncio.Task[Record]] = {}
        self._generations: dict[str, int] = {}

    async def connect(self, server: Record) -> Record:
        identifier = server["serverId"]
        existing = self.sessions.get(identifier)
        if existing and _stable(existing["server"]) == _stable(server):
            return existing
        if identifier in self._connecting:
            return await asyncio.shield(self._connecting[identifier])
        task = asyncio.create_task(self._create_session(server))
        self._connecting[identifier] = task
        try:
            return await asyncio.shield(task)
        finally:
            if self._connecting.get(identifier) is task:
                self._connecting.pop(identifier, None)

    async def _create_session(self, server: Record) -> Record:
        identifier = server["serverId"]
        if identifier in self.sessions:
            await self.disconnect(identifier)
        generation = self._generations.get(identifier, 0) + 1
        self._generations[identifier] = generation
        token = self.secrets.get(f"mcp:{identifier}")["token"]
        ready: asyncio.Future[Record] = asyncio.get_running_loop().create_future()
        stop = asyncio.Event()

        async def owner() -> None:
            try:
                async with AsyncExitStack() as stack:
                    http = await stack.enter_async_context(
                        httpx.AsyncClient(
                            headers={"Authorization": f"Bearer {token}"},
                            timeout=httpx.Timeout(30, read=None),
                        )
                    )
                    read, write, _ = await stack.enter_async_context(
                        compatible_http_client(server["url"], http)
                    )
                    client = await stack.enter_async_context(
                        ClientSession(
                            read,
                            write,
                            read_timeout_seconds=timedelta(seconds=60),
                            client_info=types.Implementation(
                                name="hardwareharness-internal-client", version="0.1.0"
                            ),
                        )
                    )
                    await client.initialize()
                    listed = await client.list_tools()
                    tools: list[Record] = []
                    validators: dict[str, Record] = {}
                    output_schemas = {}
                    required_tasks = set()
                    for tool in listed.tools:
                        raw = tool.model_dump(by_alias=True, exclude_none=True)
                        schema = raw["inputSchema"]
                        Draft7Validator.check_schema(schema)
                        inject = isinstance(schema.get("properties"), dict) and (
                            "hardwareId" in schema["properties"]
                        )
                        validators[tool.name] = {"input": schema, "injectHardwareId": inject}
                        if raw.get("outputSchema"):
                            Draft7Validator.check_schema(raw["outputSchema"])
                            validators[tool.name]["output"] = raw["outputSchema"]
                            output_schemas[tool.name] = raw["outputSchema"]
                        if raw.get("execution", {}).get("taskSupport") == "required":
                            required_tasks.add(tool.name)
                        public_schema = clone(schema)
                        if inject:
                            public_schema["properties"].pop("hardwareId", None)
                            if isinstance(public_schema.get("required"), list):
                                public_schema["required"] = [
                                    key for key in public_schema["required"] if key != "hardwareId"
                                ]
                        kind = (
                            raw.get("_meta", {}).get("hardwareharness", {}).get("kind", "unknown")
                        )
                        tools.append(
                            {
                                "externalName": f"{identifier}__{tool.name}",
                                "remoteName": tool.name,
                                "serverId": identifier,
                                **({"description": tool.description} if tool.description else {}),
                                "inputSchema": public_schema,
                                "kind": kind if isinstance(kind, str) else "unknown",
                            }
                        )
                    if not any(tool.name == "list_hardware" for tool in listed.tools):
                        raise RuntimeError(f"MCP server {identifier} must expose list_hardware")
                    record = {
                        "server": clone(server),
                        "client": _ClientAdapter(client, output_schemas, required_tasks),
                        "tools": tools,
                        "validators": validators,
                        "stop": stop,
                    }
                    if self._generations.get(identifier) != generation:
                        raise RuntimeError(f"MCP connection for {identifier} was superseded")
                    ready.set_result(record)
                    await stop.wait()
            except BaseException as error:
                if not ready.done():
                    ready.set_exception(_ungroup(error))
            finally:
                current = self.sessions.get(identifier)
                if current and current.get("stop") is stop:
                    self.sessions.pop(identifier, None)

        owner_task = asyncio.create_task(owner())
        try:
            session = await ready
            session["owner"] = owner_task
            self.sessions[identifier] = session
            session["hardware"] = await self._refresh_single_hardware(session)
            return session
        except BaseException:
            stop.set()
            await asyncio.gather(owner_task, return_exceptions=True)
            self.sessions.pop(identifier, None)
            raise

    async def ensure(self, server: Record) -> Record:
        return self.sessions.get(server["serverId"]) or await self.connect(server)

    async def disconnect(self, server_id: str) -> None:
        self._generations[server_id] = self._generations.get(server_id, 0) + 1
        session = self.sessions.pop(server_id, None)
        if session:
            session["stop"].set()
            await asyncio.gather(session["owner"], return_exceptions=True)

    async def close(self) -> None:
        await asyncio.gather(*(self.disconnect(identifier) for identifier in list(self.sessions)))

    def list_tools(self) -> list[Record]:
        return [
            tool
            for session in self.sessions.values()
            for tool in session.get("tools", [])
            if tool["kind"] != "internal"
        ]

    def find_tool(self, external_name: str) -> Record:
        for session in self.sessions.values():
            for tool in session.get("tools", []):
                if tool["externalName"] == external_name:
                    return {"session": session, "tool": tool}
        raise RuntimeError(f"Unknown aggregated tool: {external_name}")

    def has_tool(self, external_name: str) -> bool:
        return any(
            tool["externalName"] == external_name
            for session in self.sessions.values()
            for tool in session.get("tools", [])
        )

    async def call(self, external_name: str, args: Record, options: Record | None = None) -> Any:
        resolved = self.find_tool(external_name)
        return await self.call_remote(
            resolved["session"]["server"]["serverId"], resolved["tool"]["remoteName"], args, options
        )

    async def call_internal(
        self, server: Record, name: str, args: Record, options: Record | None = None
    ) -> Any:
        session = await self.ensure(server)
        return await self.call_remote(session["server"]["serverId"], name, args, options)

    async def call_remote(
        self, server_id: str, name: str, args: Record, options: Record | None = None
    ) -> Any:
        options = options or {}
        session = self.sessions.get(server_id)
        if not session:
            raise RuntimeError(f"MCP server is not connected: {server_id}")
        validators = session["validators"].get(name)
        metadata = options.get("metadata")
        request_args = (
            {**args, "hardwareId": metadata["hardwareId"]}
            if (
                validators
                and validators["injectHardwareId"]
                and metadata
                and metadata.get("hardwareId")
            )
            else args
        )
        if validators:
            error = schema_error(validators["input"], request_args)
            if error:
                raise app_error("invalid_argument", f"Invalid input for {name}: {error}")
        request_options = {
            **({"timeout": options["timeoutMs"]} if "timeoutMs" in options else {}),
            **({"signal": options["signal"]} if "signal" in options else {}),
        }
        result = await session["client"].call_tool(
            name,
            request_args,
            meta={"hardwareharness": metadata} if metadata is not None else None,
            options=request_options,
        )
        structured = result.get("structuredContent")
        if validators and validators.get("output") and "structuredContent" in result:
            error = schema_error(validators["output"], structured)
            if error:
                raise app_error(
                    "invalid_response", f"Invalid structuredContent from {name}: {error}"
                )
        if isinstance(structured, dict) and structured.get("ok") is False:
            remote_error = structured.get("error") or {}
            failure = app_error(
                remote_error.get("category", "error"),
                remote_error.get("message", "Remote MCP tool failed"),
                remote_error.get("details"),
            )
            raise failure
        if options.get("preserveEnvelope"):
            return result
        if isinstance(structured, dict) and "data" in structured:
            return structured["data"]
        return result.get("structuredContent", result.get("content"))

    async def list_hardware(self, servers: list[Record]) -> list[Record]:
        output = []
        for server in servers:
            if not server["enabled"]:
                continue
            with suppress(Exception):
                output.append(await self.describe_hardware(server))
        return output

    async def describe_hardware(self, server: Record) -> Record:
        session = await self.ensure(server)
        session["hardware"] = await self._refresh_single_hardware(session)
        return dict(session["hardware"])

    async def _refresh_single_hardware(self, session: Record) -> Record:
        server = session["server"]
        data = await self.call_remote(server["serverId"], "list_hardware", {})
        if not isinstance(data, list) or len(data) != 1:
            returned = len(data) if isinstance(data, list) else "a non-array"
            raise RuntimeError(
                f"MCP server {server['serverId']} violates one-Server-one-hardware: "
                f"list_hardware returned {returned}"
            )
        item = parse_reported_managed_hardware(data[0])
        if item["hardwareId"] != server["hardwareId"]:
            raise RuntimeError(
                f"MCP server {server['serverId']} returned hardwareId "
                f"{item['hardwareId']}; expected {server['hardwareId']}"
            )
        return parse_managed_hardware(
            {**item, "computerId": server["computerId"], "serverId": server["serverId"]}
        )

    async def prepare_shutdown(self, server_id: str) -> Any:
        return await self.call_remote(server_id, "hardwareharness_prepare_shutdown", {})


def _stable(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_stable(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(json_stringify(key) + ":" + _stable(value[key]) for key in sorted(value))
            + "}"
        )
    return json_stringify(value)


def _ungroup(error: BaseException) -> BaseException:
    while isinstance(error, BaseExceptionGroup) and len(error.exceptions) == 1:
        error = error.exceptions[0]
    return error
