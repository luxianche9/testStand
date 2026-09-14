from __future__ import annotations

import asyncio
from typing import Any

import pytest


def test_public_api_contains_only_hardware_and_logging() -> None:
    import hardwareharness

    assert set(hardwareharness.__all__) == {
        "call",
        "acall",
        "step",
        "log",
        "measurement",
        "attachment",
    }


def test_unmanaged_import_cannot_call_hardware(monkeypatch: pytest.MonkeyPatch) -> None:
    import hardwareharness

    monkeypatch.delenv("HARDWAREHARNESS_WORKER_URL", raising=False)
    with pytest.raises(RuntimeError, match="HardwareHarness"):
        hardwareharness.call("board", "read", {})


async def test_steps_nest_and_parallel_tasks_keep_parents(monkeypatch: pytest.MonkeyPatch) -> None:
    from hardwareharness import _transport, acall, log, measurement, step

    events: list[dict[str, Any]] = []

    def request(operation: str, data: dict[str, Any]) -> Any:
        events.append({"operation": operation, **data})
        return {"value": 4}

    monkeypatch.setattr(_transport, "request", request)

    @step("decorated")
    async def child() -> Any:
        async with step("nested"):
            log("reading")
            measurement("voltage", 3.3, unit="V")
            return await acall("board", "read", {})

    with step("root"):
        results = await asyncio.gather(child(), child())
        assert list(results) == [{"value": 4}, {"value": 4}]
    starts = [event for event in events if event.get("type") == "step.started"]
    assert len(starts) == 5
    root = starts[0]["spanId"]
    assert all(event["parentSpanId"] == root for event in starts if event["name"] == "decorated")
    assert len({event["spanId"] for event in starts}) == 5
    assert len([event for event in events if event.get("type") == "step.completed"]) == 5


def test_step_exception_and_sync_decorator(monkeypatch: pytest.MonkeyPatch) -> None:
    from hardwareharness import _transport, step

    events: list[dict[str, Any]] = []

    def request(operation: str, data: dict[str, Any]) -> None:
        events.append(data)

    monkeypatch.setattr(_transport, "request", request)

    @step("failure")
    def fail() -> None:
        raise ValueError("bad measurement")

    with pytest.raises(ValueError, match="bad measurement"):
        fail()
    assert events[-1]["data"]["status"] == "failed"
    assert "ValueError" in events[-1]["data"]["error"]["traceback"]


def test_source_when_python_frames_are_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    import inspect

    import hardwareharness

    monkeypatch.setattr(inspect, "currentframe", lambda: None)
    assert hardwareharness._source() == {}
