from __future__ import annotations

import asyncio
import io
import json
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from hardwareharness_backend.automation import AutomationService
from hardwareharness_backend.automation.logs import RunLogStore
from hardwareharness_backend.automation.service import _Run
from hardwareharness_backend.contracts.errors import AppError, app_error

from .test_service import script, wait_run


@pytest.fixture
async def prepared(tmp_path: Path) -> AsyncIterator[tuple[AutomationService, _Run]]:
    service = AutomationService(lambda: str(tmp_path), cancellation_timeout=0.1)
    store = RunLogStore(tmp_path)
    record: dict[str, Any] = {
        "runId": "run_test",
        "hardwareIds": ["board"],
        "startedAt": "2026-01-01",
        "status": "running",
        "name": "Read voltage",
        "eventCount": 0,
        "applicationId": "panel",
    }
    store.save(record)
    run = _Run(record, store, "private-token", lambda: None)
    service.active["run_test"] = run
    yield service, run
    service.active.clear()
    if run.cancellation:
        run.cancellation.cancel()
    await service.close()


async def test_hardware_start_is_durable_before_callback(
    prepared: tuple[AutomationService, _Run],
) -> None:
    service, run = prepared

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        events = run.store.events("run_test")
        assert events[-1]["type"] == "hardware.started"
        assert events[-1]["data"]["arguments"] == {"voltage": 2}
        return {"content": [{"type": "text", "text": "ok"}]}

    service.invoke = invoke
    result = await service._dispatch(
        run, "call", {"hardwareId": "board", "toolName": "set", "arguments": {"voltage": 2}}
    )
    assert result["content"][0]["text"] == "ok"
    assert run.store.events("run_test")[-1]["data"]["status"] == "succeeded"


async def test_disk_failure_prevents_any_hardware_effect(
    prepared: tuple[AutomationService, _Run], monkeypatch: pytest.MonkeyPatch
) -> None:
    service, run = prepared
    called = False

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        nonlocal called
        called = True

    def fail(*args: Any, **kwargs: Any) -> Any:
        raise OSError("disk full")

    service.invoke = invoke
    monkeypatch.setattr(run.store, "append", fail)
    message = {"hardwareId": "board", "toolName": "set", "arguments": {}}
    with pytest.raises(OSError, match="disk full"):
        await service._dispatch(run, "call", message)
    assert not called
    assert run.broken
    with pytest.raises(AppError, match="logging failed"):
        await service._dispatch(run, "call", message)


@pytest.mark.parametrize("case", ["denied", "timeout", "cancel"])
async def test_hardware_errors_preserve_category_without_replay(
    prepared: tuple[AutomationService, _Run], case: str
) -> None:
    service, run = prepared
    calls = 0

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        nonlocal calls
        calls += 1
        if case == "denied":
            raise app_error("occupancy_required", "Lease expired", {"hardwareId": hardware})
        if case == "cancel":
            raise asyncio.CancelledError()
        await asyncio.sleep(60)

    service.invoke = invoke
    with pytest.raises((AppError, asyncio.CancelledError)):
        await service._dispatch(
            run,
            "call",
            {"hardwareId": "board", "toolName": "read", "arguments": {}, "timeoutMs": 100},
        )
    assert calls == 1
    event = run.store.events("run_test")[-1]
    if case == "denied":
        assert event["data"]["error"]["category"] == "occupancy_required"
    if case == "timeout":
        assert "unknown" in event["data"]["error"]["message"]
    if case == "cancel":
        assert event["data"]["status"] == "cancelled"


@pytest.mark.parametrize(
    "operation,data",
    [
        ("occupancy.acquire", {}),
        ("event", {"type": "run.completed"}),
        ("complete", {"status": "invented"}),
        ("call", {"hardwareId": "other", "toolName": "read", "arguments": {}}),
        ("call", {"hardwareId": "board", "toolName": 5, "arguments": {}}),
        ("call", {"hardwareId": "board", "toolName": "read", "arguments": []}),
        ("call", {"hardwareId": "board", "toolName": "read", "arguments": {}, "timeoutMs": True}),
        (
            "call",
            {"hardwareId": "board", "toolName": "read", "arguments": {}, "timeoutMs": 1_800_001},
        ),
    ],
)
async def test_worker_surface_rejects_invalid_operations(
    prepared: tuple[AutomationService, _Run], operation: str, data: dict[str, Any]
) -> None:
    service, run = prepared
    with pytest.raises(AppError):
        await service._dispatch(run, operation, data)


async def test_missing_adapter_and_completed_run_reject_calls(
    prepared: tuple[AutomationService, _Run],
) -> None:
    service, run = prepared
    message = {"hardwareId": "board", "toolName": "read", "arguments": {}}
    with pytest.raises(AppError, match="adapter"):
        await service._dispatch(run, "call", message)
    await service._dispatch(run, "complete", {"status": "succeeded", "result": 3})
    with pytest.raises(AppError, match="completion"):
        await service._dispatch(run, "complete", {"status": "failed"})

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        return None

    service.invoke = invoke
    with pytest.raises(AppError, match="completed"):
        await service._dispatch(run, "call", message)


async def test_large_results_and_files_are_exportable_attachments(
    prepared: tuple[AutomationService, _Run], tmp_path: Path
) -> None:
    service, run = prepared

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        return {"data": "X" * 70_000, "token": "secret"}

    service.invoke = invoke
    result = await service._dispatch(
        run, "call", {"hardwareId": "board", "toolName": "read", "arguments": {}}
    )
    assert len(result["data"]) == 70_000
    event = run.store.events("run_test")[-1]
    attachment = event["data"]["output"]["attachment"]
    copied = await service.read_run_attachment("run_test", attachment["path"])
    assert b"secret" not in copied["content"]
    source = tmp_path / "camera.txt"
    source.write_text("camera", encoding="utf-8")
    await service._dispatch(run, "attachment", {"path": str(source), "mediaType": "text/plain"})
    archive = zipfile.ZipFile(io.BytesIO(await service.export_run("run_test")))
    assert any(name.startswith("artifacts/") for name in archive.namelist())
    with pytest.raises(AppError, match="belong"):
        await service.read_run_attachment("run_test", str(source))


async def test_list_filters_cancel_and_delete(prepared: tuple[AutomationService, _Run]) -> None:
    service, run = prepared
    assert (
        len(
            await service.list_runs(
                {"statuses": ["running"], "search": "VOLTAGE", "applicationId": "panel"}
            )
        )
        == 1
    )
    assert await service.list_runs({"status": "succeeded"}) == []
    assert await service.list_runs({"search": "absent"}) == []
    assert await service.clear_completed_runs() == {"deleted": 0}
    with pytest.raises(AppError, match="Stop"):
        await service.delete_run("run_test")
    await service.abort_hardware("board", "Lease lost")
    assert (await service.cancel_run("run_test"))["status"] == "cancelling"
    service.active.clear()
    assert (await service.cancel_run("run_test"))["status"] == "cancelling"
    assert await service.clear_completed_runs() == {"deleted": 1}
    with pytest.raises(AppError, match="Unknown"):
        await service.get_run("run_test")


@pytest.mark.parametrize(
    "method,headers,body,status",
    [
        ("GET", {}, b"{}", 403),
        ("POST", {"Host": "evil.local"}, b"{}", 403),
        ("POST", {"Origin": "http://localhost"}, b"{}", 403),
        ("POST", {"Authorization": "Bearer wrong"}, b"{}", 403),
        ("POST", {}, b"[]", 400),
        ("POST", {}, b'{"operation":"event","data":[]}', 400),
    ],
)
async def test_private_transport_auth_and_validation(
    prepared: tuple[AutomationService, _Run],
    method: str,
    headers: dict[str, str],
    body: bytes,
    status: int,
) -> None:
    service, run = prepared
    await service._listen()
    await service._listen()
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.request(
            method,
            f"http://{service.address}/rpc",
            headers={"Authorization": f"Bearer {run.token}", **headers},
            content=body,
        )
    assert response.status_code == status


async def test_private_rpc_cancellation_response(prepared: tuple[AutomationService, _Run]) -> None:
    service, run = prepared

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        raise asyncio.CancelledError()

    service.invoke = invoke
    await service._listen()
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.post(
            f"http://{service.address}/rpc",
            headers={"Authorization": f"Bearer {run.token}"},
            json={
                "operation": "call",
                "data": {"hardwareId": "board", "toolName": "read", "arguments": {}},
            },
        )
    assert response.status_code == 409
    assert response.json()["error"]["category"] == "cancelled"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"entrypoint": "absent.py"},
        {"entrypoint": "workflows/main.py", "hardwareIds": [1]},
        {"entrypoint": "workflows/main.py", "inputs": []},
        {"entrypoint": "workflows/main.py", "inputSchema": {"type": "invalid"}},
        {"entrypoint": "workflows/main.py", "context": {}},
    ],
)
async def test_bad_launch_has_no_run(tmp_path: Path, payload: dict[str, Any]) -> None:
    service = AutomationService(lambda: str(tmp_path))
    script(tmp_path, "def main(inputs): return inputs")
    with pytest.raises(AppError):
        await service.start_run(payload)
    assert await service.list_runs() == []
    await service.close()


async def test_unopened_closed_and_launch_failure_release(tmp_path: Path) -> None:
    service = AutomationService(lambda: None)
    with pytest.raises(AppError, match="Open"):
        await service.list_runs()
    await service.close()
    with pytest.raises(AppError, match="closed"):
        await service.start_run({})
    released: list[bool] = []

    async def acquire(ids: list[str], record: dict[str, Any]) -> Any:
        return lambda: released.append(True)

    async def python() -> str:
        return str(tmp_path / "absent-python.exe")

    script(tmp_path, "def main(inputs): return inputs")
    service = AutomationService(lambda: str(tmp_path), acquire=acquire, python_provider=python)
    with pytest.raises(FileNotFoundError):
        await service.start_run({"entrypoint": "workflows/main.py"})
    assert released == [True]
    assert (await service.list_runs())[0]["status"] == "failed"
    await service.close()


async def test_forced_stop_and_process_crash(tmp_path: Path) -> None:
    script(tmp_path, "def main(inputs):\n while True: pass")
    service = AutomationService(lambda: str(tmp_path), cancellation_timeout=0.1)
    run = await service.start_run({"entrypoint": "workflows/main.py"})
    await service.cancel_run(run["runId"])
    assert (await wait_run(service, run["runId"]))["run"]["status"] == "cancelled"
    script(tmp_path, "import os\ndef main(inputs): os._exit(7)")
    run = await service.start_run({"entrypoint": "workflows/main.py"})
    detail = await wait_run(service, run["runId"])
    assert detail["run"]["status"] == "failed"
    assert "exit 7" in detail["run"]["error"]["message"]
    await service.close()


async def test_normal_completion_kills_descendant_process(tmp_path: Path) -> None:
    marker = tmp_path / "orphan.txt"
    child = (
        "import time;from pathlib import Path;time.sleep(0.7);"
        f"Path({str(marker)!r}).write_text('orphan')"
    )
    script(
        tmp_path,
        "import subprocess,sys\ndef main(inputs):\n"
        f" subprocess.Popen([sys.executable, '-c', {child!r}])\n return 1",
    )
    service = AutomationService(lambda: str(tmp_path))
    run = await service.start_run({"entrypoint": "workflows/main.py"})
    assert (await wait_run(service, run["runId"]))["run"]["status"] == "succeeded"
    await asyncio.sleep(0.9)
    assert not marker.exists()
    await service.close()


async def test_raw_output_decoder_notifier_and_occurrences(tmp_path: Path) -> None:
    notifications: list[dict[str, Any]] = []
    script(
        tmp_path,
        """import os,time
from hardwareharness import step
def main(inputs):
    os.write(1, b"\\xe4")
    time.sleep(0.1)
    os.write(1, b"\\xb8\\xad")
    os.write(2, b"raw error")
    for i in range(2):
        with step("iteration"):
            pass
""",
    )
    service = AutomationService(lambda: str(tmp_path), notifier=notifications.append)
    run = await service.start_run({"entrypoint": "workflows/main.py"})
    detail = await wait_run(service, run["runId"])
    assert detail["run"]["status"] == "succeeded"
    assert (
        "".join(event["data"]["text"] for event in detail["events"] if event["type"] == "stdout")
        == "中"
    )
    assert any(event["type"] == "stderr" for event in detail["events"])
    assert [
        event["data"]["occurrence"] for event in detail["events"] if event["type"] == "step.started"
    ] == [1, 2]
    assert notifications[-1]["type"] == "run"
    assert notifications[-1]["run"]["status"] == "succeeded"
    await service.close()


async def test_worker_credentials_never_reach_records(
    prepared: tuple[AutomationService, _Run],
) -> None:
    service, run = prepared
    await service._dispatch(
        run,
        "event",
        {"type": "log", "data": {"message": f"env: {run.token}", "values": [run.token, 1]}},
    )
    await service._dispatch(run, "complete", {"status": "succeeded", "result": run.token})
    assert run.token not in json.dumps(run.store.events("run_test"))
    assert run.complete == {"status": "succeeded", "result": "[REDACTED]"}


@pytest.mark.parametrize(
    "headers,body",
    [
        ("Content-Length: 0\r\n", b""),
        ("Content-Length: 16777217\r\n", b""),
        ("Content-Length: 2\r\nContent-Length: 2\r\n", b"{}"),
        ("Transfer-Encoding: chunked\r\nContent-Length: 2\r\n", b"{}"),
    ],
)
async def test_private_http_rejects_ambiguous_or_large_bodies(
    prepared: tuple[AutomationService, _Run], headers: str, body: bytes
) -> None:
    service, run = prepared
    await service._listen()
    reader, writer = await asyncio.open_connection("127.0.0.1", int(service.address.split(":")[1]))
    writer.write(
        (
            f"POST /rpc HTTP/1.1\r\nHost: {service.address}\r\n"
            f"Authorization: Bearer {run.token}\r\n{headers}\r\n"
        ).encode()
        + body
    )
    await writer.drain()
    response = await reader.read()
    writer.close()
    await writer.wait_closed()
    assert response.startswith((b"HTTP/1.1 400", b"HTTP/1.1 403"))


async def test_close_active_run_and_cancel_inflight_callback(tmp_path: Path) -> None:
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        entered.set()
        try:
            await asyncio.sleep(60)
        finally:
            cancelled.set()

    script(
        tmp_path,
        "from hardwareharness import acall\n"
        'async def main(inputs): return await acall("board", "read", {})',
    )
    service = AutomationService(lambda: str(tmp_path), invoke, cancellation_timeout=0.3)
    run = await service.start_run({"entrypoint": "workflows/main.py", "hardwareIds": ["board"]})
    await asyncio.wait_for(entered.wait(), 10)
    await service.close()
    assert cancelled.is_set()
    assert service.active == {}
    assert (await service.get_run(run["runId"]))["run"]["status"] in {"cancelled", "failed"}


async def test_transient_log_failure_stops_process_and_reports_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script(
        tmp_path,
        "import time\nfrom hardwareharness import log\ndef main(inputs):\n"
        ' time.sleep(0.2)\n log("write")',
    )
    service = AutomationService(lambda: str(tmp_path), cancellation_timeout=0.2)
    record = await service.start_run({"entrypoint": "workflows/main.py"})
    run = service.active[record["runId"]]

    def fail(*args: Any, **kwargs: Any) -> Any:
        raise OSError("disk unavailable")

    monkeypatch.setattr(run.store, "append", fail)
    detail = await wait_run(service, record["runId"])
    assert detail["run"]["status"] == "failed"
    assert "logging failed" in detail["run"]["error"]["message"]
    await service.close()


async def test_partial_raw_character_flushes_without_losing_bytes(tmp_path: Path) -> None:
    script(tmp_path, 'import os\ndef main(inputs): os.write(1, b"\\xe4")')
    service = AutomationService(lambda: str(tmp_path))
    run = await service.start_run({"entrypoint": "workflows/main.py"})
    detail = await wait_run(service, run["runId"])
    assert any(event["data"].get("text") == "�" for event in detail["events"])
    await service.close()


async def test_external_source_location_is_retained(
    prepared: tuple[AutomationService, _Run],
) -> None:
    service, run = prepared
    source = {"path": "user_threads.py", "line": 4}
    await service._dispatch(
        run, "event", {"type": "log", "data": {"message": "thread", "source": source}}
    )
    assert run.store.events("run_test")[-1]["data"]["source"] == source


async def test_close_during_environment_preparation_never_launches_old_project(
    tmp_path: Path,
) -> None:
    preparing, resume = asyncio.Event(), asyncio.Event()
    acquired: list[bool] = []

    async def python() -> str:
        preparing.set()
        await resume.wait()
        return "python.exe"

    async def acquire(ids: list[str], record: dict[str, Any]) -> Any:
        acquired.append(True)
        return lambda: None

    script(tmp_path, "def main(inputs): return inputs")
    service = AutomationService(lambda: str(tmp_path), acquire=acquire, python_provider=python)
    startup = asyncio.create_task(service.start_run({"entrypoint": "workflows/main.py"}))
    await preparing.wait()
    await service.close()
    resume.set()
    with pytest.raises(AppError, match="closed"):
        await startup
    assert acquired == []
    assert await service.list_runs() == []


async def test_close_during_acquire_releases_claim_without_spawning(tmp_path: Path) -> None:
    preparing, resume = asyncio.Event(), asyncio.Event()
    released: list[bool] = []

    async def acquire(ids: list[str], record: dict[str, Any]) -> Any:
        preparing.set()
        await resume.wait()
        return lambda: released.append(True)

    script(tmp_path, "def main(inputs): return inputs")
    service = AutomationService(lambda: str(tmp_path), acquire=acquire)
    startup = asyncio.create_task(service.start_run({"entrypoint": "workflows/main.py"}))
    await preparing.wait()
    closing = asyncio.create_task(service.close())
    await asyncio.sleep(0)
    resume.set()
    with pytest.raises(AppError, match="closed"):
        await startup
    await closing
    assert released == [True]
    assert service.active == {}


async def test_same_hardware_overlap_conflicts_but_disjoint_calls_parallel(
    prepared: tuple[AutomationService, _Run],
) -> None:
    service, run = prepared
    run.record["hardwareIds"].append("other")
    entered, finish = asyncio.Event(), asyncio.Event()

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        if hardware == "board":
            entered.set()
            await finish.wait()
        return hardware

    service.invoke = invoke
    message = {"hardwareId": "board", "toolName": "read", "arguments": {}}
    first = asyncio.create_task(service._dispatch(run, "call", message))
    await entered.wait()
    with pytest.raises(AppError, match="active call"):
        await service._dispatch(run, "call", message)
    assert await service._dispatch(run, "call", {**message, "hardwareId": "other"}) == "other"
    finish.set()
    assert await first == "board"
    assert run.busy_hardware == set()


async def test_cancel_cannot_be_reported_as_success(
    prepared: tuple[AutomationService, _Run],
) -> None:
    service, run = prepared
    run.cancelled = True
    await service._dispatch(run, "complete", {"status": "succeeded", "result": "cleanup returned"})
    assert run.complete is not None
    assert run.complete["status"] == "cancelled"


@pytest.mark.parametrize("field,value", [("name", ""), ("applicationId", None), ("actionId", 5)])
async def test_launch_metadata_is_strict(tmp_path: Path, field: str, value: Any) -> None:
    script(tmp_path, "def main(inputs): return None")
    service = AutomationService(lambda: str(tmp_path))
    with pytest.raises(AppError, match=field):
        await service.start_run({"entrypoint": "workflows/main.py", field: value})
    await service.close()
