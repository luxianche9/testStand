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


@pytest.mark.parametrize("asynchronous", [False, True])
async def test_data_mode_selects_data_but_preserves_default_and_media(
    monkeypatch: pytest.MonkeyPatch, asynchronous: bool
) -> None:
    import hardwareharness

    envelope = {
        "content": [{"type": "image", "mimeType": "image/png", "data": "YWJj"}],
        "structuredContent": {"ok": True, "data": {"volts": 1.25}},
        "isError": False,
    }
    monkeypatch.setattr(hardwareharness._transport, "request", lambda *args: envelope)
    if asynchronous:
        assert await hardwareharness.acall("board", "read", {}) is envelope
        assert await hardwareharness.acall("board", "read", {}, result_mode="data") == {
            "volts": 1.25
        }
    else:
        assert hardwareharness.call("board", "read", {}) is envelope
        assert hardwareharness.call("board", "read", {}, result_mode="data") == {"volts": 1.25}
    assert envelope["content"][0]["data"] == "YWJj"


@pytest.mark.parametrize(
    "envelope,expected",
    [
        ({"content": [{"type": "text", "text": '{"ok":true,"data":[1,2]}'}]}, [1, 2]),
        ({"structuredContent": {"count": 2}}, {"count": 2}),
        (
            {"content": [{"type": "text", "text": "plain"}]},
            {"content": [{"type": "text", "text": "plain"}]},
        ),
    ],
)
def test_data_mode_handles_actual_result_shapes(
    monkeypatch: pytest.MonkeyPatch, envelope: Any, expected: Any
) -> None:
    import hardwareharness

    monkeypatch.setattr(hardwareharness._transport, "request", lambda *args: envelope)
    assert hardwareharness.call("board", "read", {}, result_mode="data") == expected


@pytest.mark.parametrize(
    "envelope",
    [
        {"content": [{"type": "text", "text": "failed"}], "isError": True},
        {"structuredContent": {"ok": False, "error": {"message": "offline"}}},
        {"content": [{"type": "text", "text": '{"ok":false,"error":"offline"}'}]},
    ],
)
def test_data_mode_never_treats_error_envelope_as_business_success(
    monkeypatch: pytest.MonkeyPatch, envelope: Any
) -> None:
    import hardwareharness

    monkeypatch.setattr(hardwareharness._transport, "request", lambda *args: envelope)
    with pytest.raises(RuntimeError, match="failed"):
        hardwareharness.call("board", "read", {}, result_mode="data")
    assert hardwareharness.call("board", "read", {}) is envelope


async def test_invalid_result_mode_fails_before_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    import hardwareharness

    def fail(*args: Any) -> None:
        raise AssertionError("Hardware must not be called")

    monkeypatch.setattr(hardwareharness._transport, "request", fail)
    with pytest.raises(ValueError, match="result_mode"):
        hardwareharness.call("board", "write", {}, result_mode="unknown")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="result_mode"):
        await hardwareharness.acall("board", "write", {}, result_mode="unknown")  # type: ignore[arg-type]
