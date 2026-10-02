"""Upstream SSE subscriptions to device services and per-service clock estimates.

A :class:`StreamSource` follows one ``GET /streams/{streamId}`` of a service
and yields normalized events; it reconnects with ``Last-Event-ID`` so nothing
is repeated or silently lost across drops (the service reports evicted records
as a ``gap``). Records keep the service time ``t`` and gain the backend time
``tb`` from the service's :class:`ClockEstimator`, which a sampler task feeds
from ``GET /time`` while any source of that service is open.

Events yielded by :meth:`StreamSource.events`:

* ``hello``  — ``{streamType, epoch}`` on every (re)connect
* ``batch``  — ``{records: [{seq, t, tb, op?, ...}], watermark}`` (watermark in service time)
* ``gap``    — ``{reason, fromSeq, toSeq, t0, t1}``: service times ``(t0, t1)`` have missing
  records (``overflow`` evicted from the ring buffer, ``reset`` the service restarted)
* ``status`` — service status ``{state, sampling, errors, lastError?, watermark}``
* ``state``  — connection state ``{state: disconnected | unknown_stream, message}``;
  ``unknown_stream`` ends the iteration
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import Record

from .clock import ClockEstimator, backend_ms

log = logging.getLogger("hardwareharness_backend.streams.source")

CLOCK_INTERVAL = 1.0
BACKOFF_MIN, BACKOFF_MAX = 0.2, 5.0
READ_TIMEOUT = 5.0


@dataclass(frozen=True)
class Endpoint:
    """A device service: base URL (without ``/mcp``), bearer token, clock domain key."""

    base_url: str
    token: str
    service_key: str


EndpointResolver = Callable[[str], Endpoint]


def service_base(mcp_url: str) -> str:
    """``http://host:port/mcp`` -> ``http://host:port``."""
    parts = urlsplit(mcp_url)
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path.rstrip("/").removesuffix("/mcp"), "", "")
    )


def server_endpoints(devices: Any, secrets: Any) -> EndpointResolver:
    """Resolve a hardware id through the configured MCP servers and their tokens."""

    def resolve(hardware_id: str) -> Endpoint:
        server = next(
            (
                item
                for item in devices.list_servers()
                if item.get("hardwareId") == hardware_id and item.get("enabled", True)
            ),
            None,
        )
        if server is None:
            raise app_error(
                "not_found",
                f"No enabled MCP server for hardware {hardware_id}",
                {"hardwareId": hardware_id},
            )
        token = secrets.get(f"mcp:{server['serverId']}")["token"]
        return Endpoint(service_base(server["url"]), token, server["serverId"])

    return resolve


class _ServiceClock:
    def __init__(self) -> None:
        self.estimator = ClockEstimator()
        self.users = 0
        self.task: asyncio.Task[None] | None = None


class StreamSources:
    """Creates stream sources and keeps one clock sampler per service while it is in use."""

    def __init__(
        self,
        resolver: EndpointResolver,
        *,
        client: httpx.AsyncClient | None = None,
        clock_interval: float = CLOCK_INTERVAL,
    ) -> None:
        self.resolver = resolver
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(READ_TIMEOUT, read=None), trust_env=False
        )
        self.clock_interval = clock_interval
        self._clocks: dict[str, _ServiceClock] = {}

    def source(
        self, hardware_id: str, stream_id: str, *, since: float | None = None
    ) -> StreamSource:
        """``since``: backend time of the first wanted record (pre-roll); ``None`` = new only."""
        endpoint = self.resolver(hardware_id)
        return StreamSource(self, endpoint, stream_id, since=since)

    def clock(self, hardware_id: str) -> ClockEstimator | None:
        try:
            key = self.resolver(hardware_id).service_key
        except Exception:
            return None
        entry = self._clocks.get(key)
        return entry.estimator if entry else None

    def estimator(self, endpoint: Endpoint) -> ClockEstimator:
        return self._clocks.setdefault(endpoint.service_key, _ServiceClock()).estimator

    async def prime(self, hardware_id: str, *, burst: int = 0) -> ClockEstimator:
        """Take one clock sample now unless the service's offset is already known.

        ``burst`` takes that many back to back regardless: before streams open the
        round trip is at its quietest, and the estimator keeps the best sample.
        """
        endpoint = self.resolver(hardware_id)
        estimator = self.estimator(endpoint)
        for _ in range(burst or (0 if estimator.known else 1)):
            await self.sample_clock(endpoint)
        return estimator

    async def sample_clock(self, endpoint: Endpoint) -> None:
        sent = backend_ms()
        response = await self.client.get(
            f"{endpoint.base_url}/time", headers=_auth(endpoint), timeout=READ_TIMEOUT
        )
        received = backend_ms()
        response.raise_for_status()
        self.estimator(endpoint).add(sent, float(response.json()["serverTime"]), received)

    def hold_clock(self, hardware_id: str) -> Callable[[], None]:
        """Keep sampling the service's clock until the returned release is called."""
        endpoint = self.resolver(hardware_id)
        self._acquire_clock(endpoint)
        return lambda: self._release_clock(endpoint)

    def _acquire_clock(self, endpoint: Endpoint) -> None:
        entry = self._clocks.setdefault(endpoint.service_key, _ServiceClock())
        entry.users += 1
        if entry.task is None:
            entry.task = asyncio.create_task(
                self._sample_loop(endpoint), name=f"clock:{endpoint.service_key}"
            )

    def _release_clock(self, endpoint: Endpoint) -> None:
        entry = self._clocks.get(endpoint.service_key)
        if entry is None:
            return
        entry.users -= 1
        if entry.users <= 0 and entry.task is not None:
            entry.task.cancel()
            entry.task = None

    async def _sample_loop(self, endpoint: Endpoint) -> None:
        while True:
            try:
                await self.sample_clock(endpoint)
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                log.debug("Clock sample for %s failed: %s", endpoint.service_key, exc)
            await asyncio.sleep(self.clock_interval)

    async def close(self) -> None:
        tasks = [entry.task for entry in self._clocks.values() if entry.task is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._clocks.clear()
        await self.client.aclose()


class StreamSource:
    """One followed device stream. Iterate :meth:`events`; cancel the consumer to stop."""

    def __init__(
        self,
        sources: StreamSources,
        endpoint: Endpoint,
        stream_id: str,
        *,
        since: float | None,
    ) -> None:
        self.sources = sources
        self.endpoint = endpoint
        self.stream_id = stream_id
        self.since = since
        self.clock = sources.estimator(endpoint)
        self.stream_type: str | None = None
        self.last_event_id: str | None = None
        self.watermark: float | None = None
        self._pending_gap: Record | None = None

    async def events(self) -> AsyncIterator[Record]:
        self.sources._acquire_clock(self.endpoint)
        backoff = BACKOFF_MIN
        disconnected = False
        try:
            while True:
                try:
                    async for event in self._session():
                        if event["type"] == "hello":
                            backoff, disconnected = BACKOFF_MIN, False
                        yield event
                    message = "service closed the stream"
                except _UnknownStream as exc:
                    yield {"type": "state", "state": "unknown_stream", "message": str(exc)}
                    return
                except (httpx.HTTPError, _BadStatus, ValueError, KeyError) as exc:
                    message = str(exc) or type(exc).__name__
                if not disconnected:
                    disconnected = True
                    yield {"type": "state", "state": "disconnected", "message": message}
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX)
        finally:
            self.sources._release_clock(self.endpoint)

    async def _session(self) -> AsyncIterator[Record]:
        headers = {**_auth(self.endpoint), "Accept": "text/event-stream"}
        params: dict[str, str] = {}
        if self.last_event_id is not None:
            headers["Last-Event-ID"] = self.last_event_id
        elif self.since is not None:
            # The service seeks in its own clock; convert when an estimate exists.
            since = self.clock.to_server(self.since) if self.clock.known else self.since
            params["since"] = f"{since:.3f}"
        else:
            params["from"] = "latest"
        sent = backend_ms()
        async with self.sources.client.stream(
            "GET",
            f"{self.endpoint.base_url}/streams/{self.stream_id}",
            params=params,
            headers=headers,
        ) as response:
            if response.status_code == 404:
                raise _UnknownStream(f"service has no stream {self.stream_id}")
            if response.status_code != 200:
                raise _BadStatus(f"HTTP {response.status_code}")
            async for name, data, event_id in _parse(response):
                event = self._on_event(name, data, sent)
                if event_id:
                    self.last_event_id = event_id
                for item in event:
                    yield item

    def _on_event(self, name: str, data: Record, sent: float) -> list[Record]:
        if name == "hello":
            self.clock.add(sent, float(data["serverTime"]), backend_ms())
            self.stream_type = data["streamType"]
            return [{"type": "hello", "streamType": data["streamType"], "epoch": data["epoch"]}]
        if name == "gap":
            self._open_gap(data)
            return []
        if name == "batch":
            records: list[Record] = data["records"]
            events = self._close_gap(records[0]["t"] if records else data.get("watermark"))
            for record in records:
                record["tb"] = round(self.clock.to_backend(float(record["t"])), 3)
            self._advance(data.get("watermark"))
            events.append({"type": "batch", "records": records, "watermark": self.watermark})
            return events
        if name == "status":
            events = self._close_gap(data.get("watermark"))
            self._advance(data.get("watermark"))
            events.append({"type": "status", **data})
            return events
        return []

    def _advance(self, watermark: Any) -> None:
        if isinstance(watermark, (int, float)) and (
            self.watermark is None or watermark > self.watermark
        ):
            self.watermark = float(watermark)

    def _open_gap(self, data: Record) -> None:
        if self._pending_gap is not None:
            self._pending_gap["toSeq"] = data.get("toSeq")
            return
        t0 = self.watermark
        if t0 is None:
            t0 = self.clock.to_server(self.since) if self.since is not None else 0.0
        self._pending_gap = {
            "type": "gap",
            "reason": data.get("reason"),
            "fromSeq": data.get("fromSeq"),
            "toSeq": data.get("toSeq"),
            "t0": round(t0, 3),
        }

    def _close_gap(self, t1: Any) -> list[Record]:
        gap = self._pending_gap
        if gap is None or not isinstance(t1, (int, float)):
            return []
        self._pending_gap = None
        gap["t1"] = round(max(float(t1), gap["t0"]), 3)
        return [gap]


class _UnknownStream(Exception):
    pass


class _BadStatus(Exception):
    pass


def _auth(endpoint: Endpoint) -> dict[str, str]:
    return {"Authorization": f"Bearer {endpoint.token}"}


async def _parse(response: httpx.Response) -> AsyncIterator[tuple[str, Record, str]]:
    """Server-sent events as ``(event, data, id)``; events without data are skipped."""
    name, event_id = "message", ""
    data: list[str] = []
    async for line in response.aiter_lines():
        if not line:
            if data:
                yield name, json.loads("\n".join(data)), event_id
            name, data, event_id = "message", [], ""
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            name = value
        elif field == "data":
            data.append(value)
        elif field == "id":
            event_id = value
