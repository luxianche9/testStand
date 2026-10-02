from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest

from hardwareharness_backend.streams.clock import ClockEstimator, backend_ms
from hardwareharness_backend.streams.source import (
    StreamSource,
    server_endpoints,
    service_base,
)

from .fake_service import FakeStreamService

Events = list[dict[str, Any]]


class Follower:
    """Consume a source's events in the background; wait for conditions on them."""

    def __init__(self, source: StreamSource) -> None:
        self.events: Events = []
        self._iterator: AsyncIterator[dict[str, Any]] = source.events()
        self._changed = asyncio.Event()
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        async for event in self._iterator:
            self.events.append(event)
            self._changed.set()

    async def until(self, done: Callable[[Events], bool], timeout: float = 3.0) -> Events:
        async def wait() -> None:
            while not done(self.events):
                if self.task.done():
                    raise AssertionError(f"source ended: {self.events}")
                self._changed.clear()
                await self._changed.wait()

        await asyncio.wait_for(wait(), timeout)
        return self.events

    def records(self) -> list[dict[str, Any]]:
        return [r for e in self.events if e["type"] == "batch" for r in e["records"]]

    def of(self, kind: str) -> Events:
        return [event for event in self.events if event["type"] == kind]

    async def close(self) -> None:
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.task


def values(follower: Follower, key: str = "v") -> list[Any]:
    return [record[key] for record in follower.records()]


def test_service_base_and_resolver() -> None:
    assert service_base("http://10.0.0.2:8765/mcp") == "http://10.0.0.2:8765"
    assert service_base("https://host/base/mcp/") == "https://host/base"

    class Devices:
        def list_servers(self) -> list[dict[str, Any]]:
            return [{"serverId": "S1", "hardwareId": "H1", "url": "http://h:1/mcp"}]

    class Secrets:
        def get(self, key: str) -> dict[str, str]:
            assert key == "mcp:S1"
            return {"token": "tok"}

    resolve = server_endpoints(Devices(), Secrets())
    endpoint = resolve("H1")
    assert (endpoint.base_url, endpoint.token, endpoint.service_key) == ("http://h:1", "tok", "S1")
    with pytest.raises(Exception, match="No enabled MCP server"):
        resolve("H2")


def test_clock_estimator_prefers_minimum_round_trip() -> None:
    clock = ClockEstimator(window=3)
    assert not clock.known and clock.snapshot() == {"offsetMs": None, "uncertaintyMs": None}
    clock.add(1000, 1105, 1010)  # rtt 10 -> offset 100 +- 5
    clock.add(2000, 2150, 2100)  # rtt 100 -> ignored while the better sample is in the window
    assert clock.snapshot() == {"offsetMs": 100.0, "uncertaintyMs": 5.0}
    assert clock.to_backend(1200) == 1100 and clock.to_server(1100) == 1200
    clock.add(3000, 3160, 3020)
    clock.add(4000, 4170, 4040)  # the first sample slid out
    assert clock.snapshot() == {"offsetMs": 150.0, "uncertaintyMs": 10.0}


async def test_records_get_backend_time_and_watermark() -> None:
    async with FakeStreamService({"ai0": "scalar"}, clock_skew_ms=500) as service:
        sources = service.sources()
        follower = Follower(sources.source("H", "ai0"))
        try:
            await follower.until(lambda events: bool(follower.of("hello")))
            assert follower.of("hello")[0] == {
                "type": "hello",
                "streamType": "scalar",
                "epoch": service.epoch,
            }
            service.publish("ai0", v=1.0)
            await follower.until(lambda _: values(follower) == [1.0])
            record = follower.records()[0]
            assert abs(record["t"] - record["tb"] - 500) < 50
            assert abs(record["tb"] - backend_ms()) < 1000
            await follower.until(
                lambda _: (follower.of("status") or [{}])[-1].get("watermark", 0) > record["t"]
            )
            assert service.requests[0]["from"] == "latest"
            assert sources.clock("H") is not None and sources.clock("H").known  # type: ignore[union-attr]
        finally:
            await follower.close()
            await sources.close()


async def test_resume_after_drop_keeps_every_record() -> None:
    async with FakeStreamService({"serial1": "bytes"}) as service:
        sources = service.sources()
        follower = Follower(sources.source("H", "serial1"))
        try:
            await follower.until(lambda _: bool(follower.of("hello")))
            service.publish("serial1", dir="tx", data="01")
            await follower.until(lambda _: len(follower.records()) == 1)
            service.drop()
            service.publish("serial1", dir="rx", data="02")
            await follower.until(lambda _: len(follower.records()) == 2)
            assert values(follower, "data") == ["01", "02"]
            assert follower.of("state")[0]["state"] == "disconnected"
            assert not follower.of("gap")
            assert service.requests[-1]["lastEventId"] == f"{service.epoch}:1"
        finally:
            await follower.close()
            await sources.close()


async def test_overflow_while_disconnected_is_a_timed_gap() -> None:
    async with FakeStreamService({"ai0": "scalar"}) as service:
        sources = service.sources()
        follower = Follower(sources.source("H", "ai0"))
        try:
            await follower.until(lambda _: bool(follower.of("hello")))
            service.publish("ai0", v=0)
            await follower.until(lambda _: values(follower) == [0])
            service.drop()
            for value in range(1, 4):
                service.publish("ai0", v=value)
            service.evict("ai0", 3)  # records 0..2 gone, 1 and 2 never delivered
            await follower.until(lambda _: values(follower) == [0, 3])
            gap = follower.of("gap")[0]
            assert (gap["reason"], gap["fromSeq"], gap["toSeq"]) == ("overflow", 1, 2)
            first, last = follower.records()
            assert first["t"] <= gap["t0"] < gap["t1"] == last["t"]
        finally:
            await follower.close()
            await sources.close()


async def test_service_restart_is_a_reset_gap() -> None:
    async with FakeStreamService({"di": "bits"}) as service:
        sources = service.sources()
        follower = Follower(sources.source("H", "di"))
        try:
            await follower.until(lambda _: bool(follower.of("hello")))
            service.publish("di", mask=1)
            await follower.until(lambda _: len(follower.records()) == 1)
            old_epoch = service.epoch
            service.restart()
            service.publish("di", mask=2)
            await follower.until(lambda _: len(follower.records()) == 2)
            assert follower.of("gap")[0]["reason"] == "reset"
            assert follower.records()[1]["seq"] == 0 and follower.records()[1]["mask"] == 2
            assert service.requests[-1]["lastEventId"].startswith(f"{old_epoch}:")
            assert [hello["epoch"] for hello in follower.of("hello")][-1] == service.epoch
        finally:
            await follower.close()
            await sources.close()


async def test_since_starts_at_the_preroll_without_a_gap() -> None:
    async with FakeStreamService({"ai0": "scalar"}, clock_skew_ms=-3000) as service:
        service.publish("ai0", v=-1)
        await asyncio.sleep(0.15)
        cut = backend_ms()
        for value in range(3):
            service.publish("ai0", v=value)
        service.evict("ai0", 1)
        sources = service.sources()
        await sources.prime("H")
        follower = Follower(sources.source("H", "ai0", since=cut - 50))
        try:
            await follower.until(lambda _: values(follower) == [0, 1, 2])
            assert not follower.of("gap")
            assert float(service.requests[0]["since"]) < cut - 2000  # converted to service time
        finally:
            await follower.close()
            await sources.close()


async def test_prime_burst_samples_even_when_the_offset_is_known() -> None:
    async with FakeStreamService({"ai0": "scalar"}) as service:
        sources = service.sources()
        await sources.prime("H")
        await sources.prime("H")
        assert service.time_requests == 1
        await sources.prime("H", burst=3)
        assert service.time_requests == 4
        await sources.close()


async def test_since_on_a_level_stream_includes_the_record_in_force() -> None:
    async with FakeStreamService({"di": "bits"}) as service:
        service.publish("di", mask=5)
        await asyncio.sleep(0.05)
        sources = service.sources()
        await sources.prime("H")
        follower = Follower(sources.source("H", "di", since=backend_ms()))
        try:
            await follower.until(lambda _: values(follower, "mask") == [5])
        finally:
            await follower.close()
            await sources.close()


async def test_unknown_stream_ends_the_iteration() -> None:
    async with FakeStreamService({"ai0": "scalar"}) as service:
        sources = service.sources()
        events = [event async for event in sources.source("H", "nope").events()]
        assert events == [
            {"type": "state", "state": "unknown_stream", "message": "service has no stream nope"}
        ]
        await sources.close()


async def test_clock_sampler_runs_only_while_a_source_is_open() -> None:
    async with FakeStreamService({"ai0": "scalar"}) as service:
        sources = service.sources(clock_interval=0.02)
        follower = Follower(sources.source("H", "ai0"))
        await follower.until(lambda _: bool(follower.of("hello")))
        await asyncio.sleep(0.1)
        assert service.time_requests >= 2
        await follower.close()
        await asyncio.sleep(0.05)
        count = service.time_requests
        await asyncio.sleep(0.1)
        assert service.time_requests == count
        await sources.close()
