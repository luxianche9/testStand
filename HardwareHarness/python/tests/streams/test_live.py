from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.streams.live import LiveStreams

from .fake_service import FakeStreamService

Frames = AsyncGenerator[dict[str, Any] | None, None]


async def until(frames: Frames, ready: Any, timeout: float = 5.0) -> dict[str, Any]:
    """The first frame for which ``ready(frame)`` holds."""

    async def scan() -> dict[str, Any]:
        async for frame in frames:
            if frame is not None and ready(frame):
                return frame
        raise AssertionError("frames ended")

    return await asyncio.wait_for(scan(), timeout)


def entry(frame: dict[str, Any], key: str) -> dict[str, Any]:
    return frame["streams"].get(key) or {}


async def test_frames_carry_downsampled_changes_and_feeds_are_shared(tmp_path: Path) -> None:
    async with FakeStreamService({"ai0": "scalar", "uart": "bytes"}) as service:
        sources = service.sources()
        live = LiveStreams(sources, tmp_path, frame_s=0.02, linger_s=0.1)
        frames = live.subscribe(["daq__ai0", "daq__uart"], width=100, window_ms=10_000)
        first = await anext(frames)
        assert first is not None and first["streams"] == {} and first["colMs"] == 100.0
        assert set(live.feeds) == {"daq__ai0", "daq__uart"}

        service.publish("ai0", v=1.0)
        service.publish("uart", dir="rx", data=b"OK".hex())
        seen: dict[str, list[dict[str, Any]]] = {"daq__ai0": [], "daq__uart": []}

        def both(frame: dict[str, Any]) -> bool:
            for key, value in frame["streams"].items():
                seen[key].append(value)
            return any(e.get("points") for e in seen["daq__ai0"]) and any(
                e.get("records") for e in seen["daq__uart"]
            )

        await until(frames, both)
        resets = [e["reset"] for e in seen["daq__ai0"] if "reset" in e]
        assert resets[0] is True and not any(resets[1:])
        [ai0] = [e for e in seen["daq__ai0"] if e.get("points")]
        assert [p["v"] for p in ai0["points"]] == [1.0]
        assert ai0["t0"] % 100.0 == 0  # on the absolute column grid
        records = [r for e in seen["daq__uart"] for r in e.get("records", [])]
        assert [r["dir"] for r in records] == ["rx"]

        service.publish("ai0", v=2.0)
        more = await until(frames, lambda f: entry(f, "daq__ai0").get("points"))
        update = entry(more, "daq__ai0")
        assert update["reset"] is False and update["points"][-1]["v"] == 2.0
        assert update["t0"] >= ai0["t0"]

        # A second subscriber shares the feed and gets the backlog on its first frame.
        again = live.subscribe(["daq__ai0"], width=100, window_ms=10_000)
        await anext(again)
        backlog = await until(again, lambda f: entry(f, "daq__ai0").get("points"))
        assert [p["v"] for p in entry(backlog, "daq__ai0")["points"]] == [1.0, 2.0]
        assert live.feeds["daq__ai0"].users == 2

        await again.aclose()
        await frames.aclose()
        assert live.feeds["daq__ai0"].users == 0
        paths = [feed.path for feed in live.feeds.values()]
        await asyncio.sleep(0.4)
        assert live.feeds == {} and not any(path.exists() for path in paths)
        await live.close()
        await sources.close()


async def test_resubscribing_within_the_linger_keeps_the_feed(tmp_path: Path) -> None:
    async with FakeStreamService({"ai0": "scalar"}) as service:
        sources = service.sources()
        live = LiveStreams(sources, tmp_path, frame_s=0.02, linger_s=0.3)
        frames = live.subscribe(["daq__ai0"], width=10, window_ms=1000)
        await anext(frames)
        feed = live.feeds["daq__ai0"]
        await frames.aclose()
        resumed = live.subscribe(["daq__ai0"], width=10, window_ms=1000, resume_tb=0.0)
        await anext(resumed)
        assert live.feeds["daq__ai0"] is feed and feed.closing is None
        service.publish("ai0", v=4.0)
        frame = await until(resumed, lambda f: entry(f, "daq__ai0").get("points"))
        assert entry(frame, "daq__ai0")["reset"] is False  # a resume keeps the client's buffer
        await live.close()
        assert live.feeds == {} and not list(tmp_path.glob("*.sqlite"))
        await resumed.aclose()
        await sources.close()


def test_subscriptions_are_validated_before_they_start(tmp_path: Path) -> None:
    live = LiveStreams(Any, tmp_path)  # type: ignore[arg-type]
    for keys, width, window in [
        ([], 100, 1000.0),
        (["ai0"], 100, 1000.0),
        (["daq__ai0"], 0, 1000.0),
        (["daq__ai0"], 100, 10.0),
        (["daq__ai0"], 100, 1e9),
    ]:
        with pytest.raises(AppError) as error:
            live.subscribe(keys, width=width, window_ms=window)
        assert error.value.category == "invalid_argument"
    assert live.feeds == {}


async def test_ad_hoc_observe_and_expect(tmp_path: Path) -> None:
    async with FakeStreamService({"ai0": "scalar", "uart": "bytes"}) as service:
        sources = service.sources()

        async def list_streams(hardware_id: str) -> list[dict[str, str]]:
            return [{"id": "ai0", "type": "scalar"}, {"id": "uart", "type": "bytes"}]

        live = LiveStreams(sources, tmp_path, list_streams=list_streams)

        async def feed() -> None:
            for _ in range(20):
                service.publish("ai0", v=3.3)
                await asyncio.sleep(0.02)

        writer = asyncio.create_task(feed())
        observed = await live.observe(
            "daq",
            "ai0",
            window_ms=250,
            assertions=[{"metric": "mean", "op": "within", "value": [3.2, 3.4]}],
        )
        await writer
        assert observed["verdict"]["verdict"] == "pass", observed["verdict"]
        assert observed["data"]["mode"] == "points" and observed["data"]["points"]
        assert observed["window"]["tb1"] - observed["window"]["tb0"] == pytest.approx(250)

        captured = await live.observe("daq", "ai0", window_ms=50)
        assert captured["verdict"] is None

        async def reply() -> None:
            await asyncio.sleep(0.1)
            service.publish("uart", dir="rx", data=b"READY OK".hex())

        writer = asyncio.create_task(reply())
        expected = await live.expect(
            "daq", "uart", within_ms=2000, match={"dir": "rx", "pattern": "OK"}
        )
        await writer
        assert expected["verdict"]["verdict"] == "pass"
        assert [record["dir"] for record in expected["data"]["records"]] == ["rx"]

        with pytest.raises(Exception, match="no stream"):
            await live.observe("daq", "missing", window_ms=10)
        with pytest.raises(Exception, match="windowMs"):
            await live.observe("daq", "ai0", window_ms=0)
        assert not list(tmp_path.glob("probe-*"))
        await live.close()
        await sources.close()
