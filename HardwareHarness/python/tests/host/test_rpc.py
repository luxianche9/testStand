"""Exercise the thread used by synchronous safeStorage callbacks."""

from __future__ import annotations

import asyncio
import io
import json
import os
import threading
from typing import Any

import pytest

from hardwareharness_backend.host.codec import decode, encode
from hardwareharness_backend.host.rpc import StdioRpc


@pytest.mark.asyncio
async def test_sync_callback_reply_does_not_need_blocked_event_loop() -> None:
    read_fd, write_fd = os.pipe()
    incoming = os.fdopen(read_fd, "rb", buffering=0)
    outgoing = io.BytesIO()
    rpc = StdioRpc(incoming, outgoing)
    rpc.start(asyncio.get_running_loop())

    def host() -> None:
        while not outgoing.getvalue():
            threading.Event().wait(0.001)
        request = json.loads(outgoing.getvalue())
        assert request["method"] == "host.safeStorage.encrypt"
        response = {"jsonrpc": "2.0", "id": request["id"], "result": encode(b"encrypted")}
        os.write(write_fd, (json.dumps(response) + "\n").encode())

    thread = threading.Thread(target=host)
    thread.start()
    # Intentionally blocks the asyncio loop, just as SecretStore.get does.
    assert rpc.call_host("host.safeStorage.encrypt", {"value": "plain"}, timeout=2) == b"encrypted"
    thread.join(timeout=2)
    os.close(write_fd)
    await rpc.wait_closed()
    incoming.close()


@pytest.mark.asyncio
async def test_pipelined_requests_errors_and_snapshot_precede_completion() -> None:
    incoming = io.BytesIO()
    outgoing = io.BytesIO()
    rpc = StdioRpc(incoming, outgoing)

    async def dispatch(method: str, params: Any) -> Any:
        if method == "bad":
            raise ValueError("deliberate failure")
        return params

    rpc.set_handler(dispatch, lambda: {"generation": 2})
    await rpc.handle_request(
        {"jsonrpc": "2.0", "id": "main:1", "method": "echo", "params": encode(b"a")}
    )
    await rpc.handle_request(
        {"jsonrpc": "2.0", "id": "main:2", "method": "bad", "params": encode(None)}
    )
    success, failure = [json.loads(line) for line in outgoing.getvalue().splitlines()]
    assert decode(success["result"]) == b"a"
    assert decode(success["state"])["generation"] == 2
    assert decode(failure["error"])["message"] == "deliberate failure"
    assert decode(failure["state"])["generation"] == 2
