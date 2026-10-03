from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from teststand_backend.application import HUMAN_REQUEST_CONTEXT as HUMAN
from teststand_backend.application import DefaultAuthorizer, StreamsApplication
from teststand_backend.application.cancellation import (
    AbortController,
    AbortError,
    abortable_delay,
    with_abort,
)


def streams(live: Any = None) -> tuple[StreamsApplication, Mock]:
    devices = Mock(
        list_streams=AsyncMock(return_value=[{"id": "ain0", "type": "scalar"}]),
    )
    return StreamsApplication(DefaultAuthorizer(), devices, live), devices


async def test_streams_delegate_to_devices_live_streams_and_runs() -> None:
    live = Mock(
        observe=AsyncMock(return_value={"verdict": None}),
        expect=AsyncMock(return_value={"verdict": {"verdict": "Pass"}}),
    )
    app, devices = streams(live)

    assert await app.list_streams(HUMAN, "H") == [{"id": "ain0", "type": "scalar"}]
    await app.observe(HUMAN, "H", "ain0", 100, [{"metric": "mean", "op": "gt", "expected": 1}])
    assert live.observe.await_args.kwargs["window_ms"] == 100
    await app.expect(HUMAN, "H", "uart", 50, {"dir": "rx", "contains": "OK"})
    assert live.expect.await_args.kwargs == {
        "within_ms": 50,
        "match": {"dir": "rx", "contains": "OK"},
    }

    with pytest.raises(Exception, match="Run recordings are not available"):
        app.window(HUMAN, "R", ["H__ain0"], 0.0, 10.0, 100)
    app.runs = Mock(stream_window=Mock(return_value={"runId": "R"}))
    assert app.window(HUMAN, "R", ["H__ain0"], 0.0, 10.0, 100) == {"runId": "R"}
    app.runs.stream_window.assert_called_once_with("R", ["H__ain0"], 0.0, 10.0, 100)


async def test_live_operations_are_unavailable_without_a_live_service() -> None:
    app, _ = streams()
    with pytest.raises(Exception, match="Live streams are not available") as error:
        await app.observe(HUMAN, "H", "ain0", 100)
    assert getattr(error.value, "category", None) == "unavailable"


async def test_abort_propagates_to_children_and_runs_callbacks_once() -> None:
    parent = AbortController()
    child = AbortController(parent.signal)
    seen: list[str] = []
    child.signal.add_callback(lambda: seen.append("child"))
    removed = lambda: seen.append("removed")  # noqa: E731
    child.signal.add_callback(removed)
    child.signal.remove_callback(removed)
    child.signal.remove_callback(removed)

    reason = RuntimeError("stop")
    parent.abort(reason)
    parent.abort(RuntimeError("ignored"))
    assert child.signal.aborted and child.signal.reason is reason
    assert seen == ["child"]
    with pytest.raises(RuntimeError, match="stop"):
        child.signal.throw_if_aborted()

    late = AbortController(parent.signal)
    assert late.signal.reason is reason
    fresh = AbortController()
    fresh.abort()
    with pytest.raises(AbortError):
        fresh.signal.throw_if_aborted()


async def test_with_abort_returns_results_and_detaches_on_abort() -> None:
    controller = AbortController()

    async def value() -> int:
        return 7

    assert await with_abort(value(), controller.signal) == 7

    started = asyncio.Event()

    async def slow() -> int:
        started.set()
        await asyncio.sleep(0.05)
        raise ValueError("late failure is consumed")

    pending = asyncio.create_task(with_abort(slow(), controller.signal))
    await started.wait()
    controller.abort()
    with pytest.raises(AbortError):
        await pending
    await asyncio.sleep(0.1)

    async def failed() -> int:
        raise ValueError("done before abort")

    aborted = AbortController()
    aborted.abort(RuntimeError("already"))
    with pytest.raises(RuntimeError, match="already"):
        await with_abort(failed(), aborted.signal)


async def test_abortable_delay_elapses_or_raises() -> None:
    controller = AbortController()
    await abortable_delay(1, controller.signal)

    task = asyncio.create_task(abortable_delay(10_000, controller.signal))
    await asyncio.sleep(0)
    controller.abort()
    with pytest.raises(AbortError):
        await task
    with pytest.raises(AbortError):
        await abortable_delay(1, controller.signal)
