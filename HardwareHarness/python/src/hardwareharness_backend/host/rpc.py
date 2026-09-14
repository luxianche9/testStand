"""Concurrent JSON-RPC, including synchronous OS-crypto reverse calls."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import threading
from collections.abc import Awaitable, Callable
from typing import Any, BinaryIO

from hardwareharness_backend.contracts.errors import AppError, to_wire_error
from hardwareharness_backend.host.codec import decode, encode

Handler = Callable[[str, Any], Awaitable[Any]]


class StdioRpc:
    def __init__(self, incoming: BinaryIO, outgoing: BinaryIO) -> None:
        self.incoming = incoming
        self.outgoing = outgoing
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, concurrent.futures.Future[Any]] = {}
        self._next_id = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._handler: Handler | None = None
        self._snapshot: Callable[[], Any] = lambda: None
        self._closed = asyncio.Event()
        self._reader: threading.Thread | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self._failure: Exception | None = None

    def set_handler(self, handler: Handler, snapshot: Callable[[], Any]) -> None:
        self._handler = handler
        self._snapshot = snapshot

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._reader = threading.Thread(target=self._read, name="desktop-rpc", daemon=True)
        self._reader.start()

    def send(self, frame: dict[str, Any]) -> None:
        data = (
            json.dumps(frame, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n"
        ).encode("utf-8")
        with self._write_lock:
            self.outgoing.write(data)
            self.outgoing.flush()

    def notify(self, method: str, params: Any) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": encode(params)})

    def call_host(self, method: str, params: Any, timeout: float = 30) -> Any:
        if self._failure is not None:
            raise self._failure
        future: concurrent.futures.Future[Any] = concurrent.futures.Future()
        with self._pending_lock:
            self._next_id += 1
            identifier = f"python:{self._next_id}"
            self._pending[identifier] = future
        try:
            self.send(
                {"jsonrpc": "2.0", "id": identifier, "method": method, "params": encode(params)}
            )
            return future.result(timeout=timeout)
        finally:
            with self._pending_lock:
                self._pending.pop(identifier, None)

    async def handle_request(self, frame: dict[str, Any]) -> None:
        identifier = frame.get("id")
        try:
            if frame.get("jsonrpc") != "2.0" or not isinstance(frame.get("method"), str):
                raise ValueError("Invalid JSON-RPC request")
            if self._handler is None:
                raise RuntimeError("Backend dispatcher is not initialized")
            result = await self._handler(
                frame["method"], decode(frame.get("params", ["undefined"]))
            )
            response = {"jsonrpc": "2.0", "id": identifier, "result": encode(result)}
        except Exception as error:
            response = {"jsonrpc": "2.0", "id": identifier, "error": encode(to_wire_error(error))}
        if identifier is not None:
            response["state"] = encode(self._snapshot())
            self.send(response)

    def _schedule(self, frame: dict[str, Any]) -> None:
        task = asyncio.create_task(self.handle_request(frame))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _read(self) -> None:
        failure: Exception = ConnectionError("Desktop process pipe closed")
        try:
            for line in self.incoming:
                frame = json.loads(line)
                if not isinstance(frame, dict):
                    raise ValueError("Invalid JSON-RPC frame")
                if "method" in frame:
                    if self._loop is not None:
                        self._loop.call_soon_threadsafe(self._schedule, frame)
                    continue
                with self._pending_lock:
                    future = self._pending.get(str(frame.get("id")))
                if future is None or future.done():
                    continue
                if "error" in frame:
                    error = decode(frame["error"])
                    future.set_exception(
                        AppError(
                            error.get("category", "error"),
                            error.get("message", "Host callback failed"),
                        )
                    )
                else:
                    # Deliberately completes on this thread. The loop may be in get().
                    future.set_result(decode(frame["result"]))
        except Exception as error:
            failure = error
        finally:
            with self._pending_lock:
                self._failure = failure
                for future in self._pending.values():
                    if not future.done():
                        future.set_exception(failure)
            if self._loop is not None:
                self._loop.call_soon_threadsafe(self._closed.set)

    async def wait_closed(self) -> None:
        await self._closed.wait()


class DesktopSecretProtector:
    def __init__(self, rpc: StdioRpc) -> None:
        self.rpc = rpc

    def encrypt(self, value: str) -> bytes:
        result = self.rpc.call_host("host.safeStorage.encrypt", {"value": value})
        if not isinstance(result, bytes):
            raise ValueError("Invalid encrypted secret response")
        return result

    def decrypt(self, value: bytes) -> str:
        result = self.rpc.call_host("host.safeStorage.decrypt", {"value": value})
        if not isinstance(result, str):
            raise ValueError("Invalid decrypted secret response")
        return result
