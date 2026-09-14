from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import sys
import threading
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

import pytest

from hardwareharness import _transport, _worker, attachment, step


@pytest.fixture(autouse=True)
def reset_cancellation() -> Any:
    _transport._cancelled.clear()
    _transport._cancel_delivered.clear()
    yield
    _transport._cancelled.clear()
    _transport._cancel_delivered.clear()


def test_transport_json_success_and_hardware_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARDWAREHARNESS_WORKER_URL", "http://127.0.0.1:1/rpc")
    monkeypatch.setenv("HARDWAREHARNESS_WORKER_TOKEN", "secret")

    def success(message: Any, *, timeout: float) -> io.BytesIO:
        assert message.headers["Authorization"] == "Bearer secret"
        assert json.loads(message.data)["operation"] == "call"
        assert timeout == 35
        return io.BytesIO(b'{"result":{"value":3}}')

    monkeypatch.setattr(_transport, "urlopen", success)
    assert _transport.request("call", {}) == {"value": 3}

    def reject(message: Any, *, timeout: float) -> Any:
        raise HTTPError(
            "url",
            403,
            "Denied",
            Message(),
            io.BytesIO(
                b'{"error":{"category":"occupancy_required","message":"hold first",'
                b'"details":{"id":"a"}}}'
            ),
        )

    monkeypatch.setattr(_transport, "urlopen", reject)
    with pytest.raises(_transport.HardwareHarnessError, match="hold first") as caught:
        _transport.request("event", {})
    assert caught.value.category == "occupancy_required"
    assert caught.value.details == {"id": "a"}


@pytest.mark.parametrize("failure", ["network", "bad_json_error", "invalid_response"])
def test_transport_failure_is_explicit(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    monkeypatch.setenv("HARDWAREHARNESS_WORKER_URL", "http://127.0.0.1:1/rpc")
    monkeypatch.setenv("HARDWAREHARNESS_WORKER_TOKEN", "secret")

    def broken(message: Any, *, timeout: float) -> io.BytesIO:
        if failure == "network":
            raise URLError("gone")
        if failure == "bad_json_error":
            raise HTTPError("url", 500, "error", Message(), io.BytesIO(b"broken"))
        return io.BytesIO(b"[]")

    monkeypatch.setattr(_transport, "urlopen", broken)
    with pytest.raises(_transport.HardwareHarnessError):
        _transport.request("call", {})


def test_cancel_delivered_once_allows_finally_cleanup() -> None:
    _transport._cancelled.set()
    with pytest.raises(_transport.RunCancelled):
        _transport.check_cancelled()
    _transport.check_cancelled()


def test_step_validates_reentry_and_attachments(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    events: list[dict[str, Any]] = []

    def request(operation: str, data: dict[str, Any]) -> Any:
        events.append({"operation": operation, **data})

    monkeypatch.setattr(_transport, "request", request)
    with pytest.raises(ValueError, match="name"):
        step("")
    block = step("once")
    with block, pytest.raises(RuntimeError, match="separate"):
        block.__enter__()
    attachment(tmp_path / "image.png", name="camera.png", media_type="image/png")
    assert events[-1]["operation"] == "attachment"
    assert events[-1]["name"] == "camera.png"
    assert events[-1]["spanId"] is None


async def test_worker_sync_async_and_missing_entrypoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async_path = tmp_path / "async.py"
    async_path.write_text("async def main(inputs): return inputs['n'] + 1", encoding="utf-8")
    stop = threading.Event()
    try:
        assert await _worker._execute(async_path, {"n": 2}, stop) == 3
    finally:
        stop.set()
    sync = tmp_path / "sync.py"
    sync.write_text("def main(inputs): return inputs", encoding="utf-8")
    stop = threading.Event()
    try:
        assert await _worker._execute(sync, {"n": 1}, stop) == {"n": 1}
    finally:
        stop.set()
    missing = tmp_path / "missing.py"
    missing.write_text("value = 1", encoding="utf-8")
    with pytest.raises(ValueError, match="main"):
        await _worker._execute(missing, {}, threading.Event())
    monkeypatch.setattr(importlib.util, "spec_from_file_location", lambda *args: None)
    with pytest.raises(RuntimeError, match="load"):
        await _worker._execute(missing, {}, threading.Event())


@pytest.mark.parametrize("control", ["cancel", "disconnect"])
async def test_worker_cancellation_monitor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, control: str
) -> None:
    source = tmp_path / "waiting.py"
    source.write_text(
        "import asyncio\nasync def main(inputs): await asyncio.sleep(60)", encoding="utf-8"
    )

    calls = 0

    def request(operation: str, data: dict[str, Any]) -> Any:
        nonlocal calls
        calls += 1
        if control == "disconnect":
            raise OSError("backend disappeared")
        return {"cancelled": calls > 1}

    monkeypatch.setattr(_transport, "request", request)
    stop = threading.Event()
    try:
        with pytest.raises(asyncio.CancelledError):
            await _worker._execute(source, {}, stop)
    finally:
        stop.set()


async def test_sync_worker_cancel_waits_for_sdk_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "sync_cancel.py"
    source.write_text(
        "import time\nfrom hardwareharness._transport import check_cancelled\n"
        "def main(inputs):\n time.sleep(0.3)\n check_cancelled()",
        encoding="utf-8",
    )

    def request(operation: str, data: dict[str, Any]) -> Any:
        return {"cancelled": True}

    monkeypatch.setattr(_transport, "request", request)
    stop = threading.Event()
    try:
        with pytest.raises(_transport.RunCancelled):
            await _worker._execute(source, {}, stop)
    finally:
        stop.set()


@pytest.mark.parametrize("kind", ["success", "failure", "cancel", "remote_cancel"])
def test_worker_main_completion_and_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    source = tmp_path / "main.py"
    code = {
        "success": 'def main(inputs):\n print("hello")\n return 7',
        "failure": 'def main(inputs): raise ValueError("broken")',
        "cancel": "from hardwareharness._transport import RunCancelled\n"
        "def main(inputs): raise RunCancelled()",
        "remote_cancel": "from hardwareharness._transport import HardwareHarnessError\n"
        "def main(inputs): raise HardwareHarnessError('cancelled', 'remote cancelled')",
    }[kind]
    source.write_text(code, encoding="utf-8")
    launch = tmp_path / "launch.json"
    launch.write_text(
        json.dumps({"snapshot": str(tmp_path), "entrypoint": "main.py", "inputs": {}}),
        encoding="utf-8",
    )
    events: list[dict[str, Any]] = []

    def request(operation: str, data: dict[str, Any]) -> Any:
        events.append({"operation": operation, **data})
        return {"cancelled": False}

    monkeypatch.setattr(_transport, "request", request)
    monkeypatch.setattr(sys, "stdin", io.StringIO(launch.read_text()))
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(sys, "stdout", sys.stdout)
    monkeypatch.setattr(sys, "stderr", sys.stderr)
    monkeypatch.chdir(tmp_path)
    _worker.main()
    expected = {
        "success": "succeeded",
        "failure": "failed",
        "cancel": "cancelled",
        "remote_cancel": "cancelled",
    }[kind]
    assert events[-1]["status"] == expected
    assert _worker._Output("stdout").writable()
    assert _worker._Output("stdout").write("") == 0
    if kind == "success":
        assert events[-1]["result"] == 7
        assert any(event.get("type") == "stdout" for event in events)
