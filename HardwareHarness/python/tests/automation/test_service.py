from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.automation import AutomationService


async def wait_run(service: AutomationService, run_id: str) -> dict[str, Any]:
    async with asyncio.timeout(15):
        while True:
            detail = await service.get_run(run_id)
            if detail["run"]["status"] not in {"running", "cancelling"}:
                return detail
            await asyncio.sleep(0.03)


def script(root: Path, source: str) -> None:
    path = root / ".hardwareharness" / "scripts" / "main.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")


async def test_worker_snapshots_calls_and_records_actual_execution(tmp_path: Path) -> None:
    calls: list[tuple[str, str, dict[str, Any]]] = []

    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        calls.append((hardware, tool, arguments))
        assert timeout > 0
        return {"content": [{"type": "text", "text": "ok"}], "structuredContent": {"v": 3.3}}

    async def python() -> str:
        return sys.executable

    script(
        tmp_path,
        """from hardwareharness import call, step, measurement
def main(inputs):
    with step("measure"):
        print("hello 世界")
        result = call("board", "read", inputs)
        measurement("voltage", 3.3, unit="V")
        return result
""",
    )
    service = AutomationService(lambda: str(tmp_path), invoke, python_provider=python)
    try:
        record = await service.start_run(
            {"entrypoint": "scripts/main.py", "inputs": {"n": 2}, "hardwareIds": ["board"]}
        )
        detail = await wait_run(service, record["runId"])
        assert detail["run"]["status"] == "succeeded", detail
        assert calls == [("board", "read", {"n": 2})]
        events = detail["events"]
        assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
        types = [event["type"] for event in events]
        assert types.index("hardware.started") < types.index("hardware.completed")
        assert {"step.started", "step.completed", "stdout", "measurement"} <= set(types)
        step_id = next(event["spanId"] for event in events if event["type"] == "step.started")
        assert all(event["spanId"] == step_id for event in events if event["type"] == "stdout")
        script(tmp_path, "def main(inputs): return 0")
        assert "measure" in await service.read_run_source(record["runId"], "scripts/main.py")
    finally:
        await service.close()


async def test_worker_rejects_undeclared_hardware_and_records_failure(tmp_path: Path) -> None:
    async def invoke(hardware: str, tool: str, arguments: dict[str, Any], timeout: int) -> Any:
        pytest.fail("Unauthorized hardware reached callback")

    script(
        tmp_path,
        'from hardwareharness import call\ndef main(inputs): return call("other", "read", {})',
    )
    service = AutomationService(lambda: str(tmp_path), invoke)
    try:
        run = await service.start_run({"entrypoint": "scripts/main.py", "hardwareIds": []})
        detail = await wait_run(service, run["runId"])
        assert detail["run"]["status"] == "failed"
        assert "not declared" in detail["run"]["error"]["message"]
    finally:
        await service.close()


async def test_validation_does_not_start_process(tmp_path: Path) -> None:
    service = AutomationService(lambda: str(tmp_path))
    script(tmp_path, "def main(inputs): return inputs")
    with pytest.raises(Exception, match="entrypoint"):
        await service.start_run({"entrypoint": "../escape.py"})
    with pytest.raises(Exception, match="inputs"):
        await service.start_run(
            {
                "entrypoint": "scripts/main.py",
                "inputs": {"n": "bad"},
                "inputSchema": {"type": "object", "properties": {"n": {"type": "number"}}},
            }
        )
    assert await service.list_runs() == []
    await service.close()


async def test_restart_marks_unfinished_run_interrupted(tmp_path: Path) -> None:
    directory = tmp_path / ".hardwareharness" / "logs" / "application-runs" / "run_123"
    directory.mkdir(parents=True)
    (directory / "run.json").write_text(
        json.dumps(
            {
                "runId": "run_123",
                "status": "running",
                "startedAt": "2020-01-01T00:00:00Z",
                "eventCount": 0,
            }
        ),
        encoding="utf-8",
    )
    service = AutomationService(lambda: str(tmp_path))
    detail = await service.get_run("run_123")
    assert detail["run"]["status"] == "interrupted"
    assert detail["events"][-1]["type"] == "run.completed"
    await service.close()


async def test_async_cancel_runs_finally_and_releases_execution(tmp_path: Path) -> None:
    released: list[bool] = []

    async def acquire(ids: list[str], record: dict[str, Any]) -> Any:
        return lambda: released.append(True)

    script(
        tmp_path,
        """import asyncio
from hardwareharness import log
async def main(inputs):
    try:
        log("ready")
        await asyncio.sleep(100)
    finally:
        log("cleanup")
""",
    )
    service = AutomationService(lambda: str(tmp_path), acquire=acquire)
    try:
        run = await service.start_run({"entrypoint": "scripts/main.py"})
        async with asyncio.timeout(10):
            while not any(e["type"] == "log" for e in await service.run_events(run["runId"])):
                await asyncio.sleep(0.03)
        await service.cancel_run(run["runId"])
        detail = await wait_run(service, run["runId"])
        assert detail["run"]["status"] == "cancelled"
        assert any(e["data"].get("message") == "cleanup" for e in detail["events"])
        assert released == [True]
    finally:
        await service.close()
