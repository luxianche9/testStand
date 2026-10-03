"""Live view hub (design doc 5.9.3) and the ad-hoc verdicts.

``subscribe`` backs ``GET /api/live``: every followed stream has one feed, a
:class:`StreamRecorder` into a temporary database under ``root``, shared by all
subscribers and pruned to the last ``retain_ms``. Every ``frame_s`` a subscriber gets the
changes of its streams, min/max downsampled to its pixel columns. The last subscriber
leaving starts a ``linger_s`` grace period, after which the feed stops and its database
is deleted; closing the connection is the whole unsubscribe.

``observe`` / ``expect`` are the same verdicts as the run steps, but ad hoc: the window
starts now, the stream is recorded into a throw-away database for just that long, and
the verdict comes back together with what was seen.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from teststand_backend.contracts.errors import app_error
from teststand_backend.util import Record

from . import judge
from .clock import SHARED_CLOCK, backend_ms
from .data import stream_key
from .recorder import BlobFetcher, StreamRecorder
from .source import StreamSources
from .store import SAMPLED_TYPES, StreamStore, check_keys, column_ms

log = logging.getLogger("teststand_backend.streams.live")

FRAME_S = 0.05
LINGER_S = 5.0
RETAIN_MS = 600_000.0
MIN_WINDOW_MS = 100.0
KEEPALIVE_S = 15.0
PRUNE_S = 5.0
FRAME_RECORDS = 2000
"""Records per stream per frame; a new subscriber's backlog is as long."""
WATERMARK_GRACE_S = 2.0
EXPECT_POLL_S = 0.2
MAX_PROBE_MS = 60_000.0
PROBE_POINTS = 2000

StreamLister = Callable[[str], Awaitable[list[Record]]]
"""``hardwareId -> [{id, type}]`` (the service's ``list_streams``)."""


@dataclass
class _Feed:
    key: str
    path: Path
    store: StreamStore
    recorder: StreamRecorder
    users: int = 0
    closing: asyncio.TimerHandle | None = None


@dataclass
class _Cursor:
    version: tuple[Any, ...] | None = None
    after: int | None = None
    """Last record ``i`` sent."""
    started: bool = False


class LiveStreams:
    def __init__(
        self,
        sources: StreamSources,
        root: Path,
        *,
        list_streams: StreamLister | None = None,
        fetch_blob: BlobFetcher | None = None,
        frame_s: float = FRAME_S,
        linger_s: float = LINGER_S,
        retain_ms: float = RETAIN_MS,
        keepalive_s: float = KEEPALIVE_S,
    ) -> None:
        self.sources = sources
        self.root = root
        self.list_streams = list_streams
        self.fetch_blob = fetch_blob
        self.frame_s, self.linger_s = frame_s, linger_s
        self.retain_ms, self.keepalive_s = retain_ms, keepalive_s
        self.feeds: dict[str, _Feed] = {}
        self._closing: set[asyncio.Task[None]] = set()

    # -- subscriptions ---------------------------------------------------------------------------

    def subscribe(
        self,
        keys: list[str],
        *,
        width: int,
        window_ms: float,
        resume_tb: float | None = None,
    ) -> AsyncGenerator[Record | None, None]:
        """Validate, then the frames of ``keys`` (``None``: nothing to send, keep alive).

        Every frame is ``{t, colMs, streams: {key: entry}}`` with an entry per changed
        stream: :meth:`StreamStore.window` of it, plus ``reset`` on a sampled stream's first
        entry. A sampled entry replaces the client's points from its ``t0`` on; a record
        entry appends; an entry without ``points``/``records`` only updates the watermark,
        gaps and state. ``resume_tb`` (``Last-Event-ID``) continues after that frame.
        """
        keys = check_keys([str(key) for key in keys])
        for key in keys:
            hardware_id, _, stream_id = key.partition("__")
            if not hardware_id or not stream_id:
                raise app_error("invalid_argument", f"Not a stream key: {key}", {"key": key})
        window_ms = float(window_ms)
        if not MIN_WINDOW_MS <= window_ms <= self.retain_ms:
            raise app_error(
                "invalid_argument",
                f"window must be in [{MIN_WINDOW_MS:g}, {self.retain_ms:g}] ms",
                {"window": window_ms},
            )
        col = column_ms(window_ms, int(width))
        return self._frames(keys, col, window_ms, resume_tb)

    async def _frames(
        self, keys: list[str], col: float, window_ms: float, resume_tb: float | None
    ) -> AsyncGenerator[Record | None, None]:
        feeds: list[_Feed] = []
        try:
            for key in keys:
                feeds.append(await self._acquire(key, window_ms))
            loop = asyncio.get_running_loop()
            cursors = {feed.key: _Cursor() for feed in feeds}
            yield {"t": backend_ms(), "colMs": col, "streams": {}}
            sent = pruned = loop.time()
            while True:
                await asyncio.sleep(self.frame_s)
                if any(feed.store.closed for feed in feeds):
                    return
                now = backend_ms()
                if loop.time() - pruned >= PRUNE_S:
                    pruned = loop.time()
                    for feed in feeds:
                        feed.store.prune(now - self.retain_ms)
                start = now - window_ms
                if resume_tb is not None:
                    start = max(start, resume_tb)
                changed: Record = {}
                for feed in feeds:
                    entry = _entry(feed.store, feed.key, cursors[feed.key], start, col, resume_tb)
                    if entry is not None:
                        changed[feed.key] = entry
                if changed:
                    sent = loop.time()
                    yield {"t": now, "colMs": col, "streams": changed}
                elif loop.time() - sent >= self.keepalive_s:
                    sent = loop.time()
                    yield None
        finally:
            for feed in feeds:
                self._release(feed)

    async def _acquire(self, key: str, window_ms: float) -> _Feed:
        feed = self.feeds.get(key)
        if feed is not None:
            feed.users += 1
            if feed.closing is not None:
                feed.closing.cancel()
                feed.closing = None
            return feed
        hardware_id, _, stream_id = key.partition("__")
        path = self.root / f"feed-{uuid.uuid4().hex[:12]}.sqlite"
        store = StreamStore(path)
        recorder = StreamRecorder(
            self.sources,
            store,
            [(hardware_id, stream_id)],
            preroll_ms=window_ms,
            tail_ms=0,
            fetch_blob=self.fetch_blob,
        )
        feed = _Feed(key, path, store, recorder, users=1)
        self.feeds[key] = feed
        await recorder.start()
        return feed

    def _release(self, feed: _Feed) -> None:
        feed.users -= 1
        if feed.users > 0 or self.feeds.get(feed.key) is not feed:
            return
        loop = asyncio.get_running_loop()

        def close() -> None:
            feed.closing = None
            if feed.users == 0 and self.feeds.get(feed.key) is feed:
                task = loop.create_task(self._close(feed), name=f"live-close:{feed.key}")
                self._closing.add(task)
                task.add_done_callback(self._closing.discard)

        feed.closing = loop.call_later(self.linger_s, close)

    # -- ad-hoc verdicts -------------------------------------------------------------------------

    async def observe(
        self,
        hardware_id: str,
        stream_id: str,
        *,
        window_ms: float,
        assertions: list[Record] | None = None,
        min_samples: int = judge.MIN_SAMPLES,
    ) -> Record:
        """Record ``windowMs`` from now; judge ``assertions`` if any, and return the samples."""
        assertions = list(assertions or [])
        stream_type = await self._stream_type(hardware_id, stream_id)
        for assertion in assertions:
            message = judge.assertion_error(assertion) or judge.metric_error(
                stream_type, str(assertion.get("metric"))
            )
            if message:
                raise app_error("invalid_argument", message, {"assertion": assertion})
        window_ms = _probe_length(window_ms, "windowMs")
        async with self._probe(hardware_id, stream_id) as (store, recorder):
            key = stream_key(hardware_id, stream_id)
            t0 = backend_ms()
            window = judge.Window(t0, t0 + window_ms)
            await recorder.wait_watermark(
                hardware_id, stream_id, window.t1, window_ms / 1000 + WATERMARK_GRACE_S
            )
            snapshot = dict(SHARED_CLOCK.snapshot())
            verdict = (
                judge.observe(
                    store.stream_data(key, window.t0, window.t1),
                    window,
                    assertions,
                    min_samples=min_samples,
                )
                if assertions
                else None
            )
            return _probe_result(hardware_id, stream_id, store, key, window, snapshot, verdict)

    async def expect(
        self, hardware_id: str, stream_id: str, *, within_ms: float, match: Record
    ) -> Record:
        """Wait up to ``withinMs`` from now for a record matching ``match``."""
        stream_type = await self._stream_type(hardware_id, stream_id)
        message = judge.match_error(stream_type, match)
        if message:
            raise app_error("invalid_argument", message, {"match": match})
        within_ms = _probe_length(within_ms, "withinMs")
        async with self._probe(hardware_id, stream_id) as (store, recorder):
            key = stream_key(hardware_id, stream_id)
            t0 = backend_ms()
            window = judge.Window(t0, t0 + within_ms)
            deadline = backend_ms() + within_ms + WATERMARK_GRACE_S * 1000
            while True:
                verdict = judge.expect(store.stream_data(key, window.t0, window.t1), window, match)
                remaining = (deadline - backend_ms()) / 1000
                if (
                    verdict["verdict"] == judge.PASS
                    or verdict.get("reason") != "watermark_timeout"
                    or remaining <= 0
                ):
                    break
                await store.wait_change(min(remaining, EXPECT_POLL_S))
            return _probe_result(
                hardware_id, stream_id, store, key, window, dict(SHARED_CLOCK.snapshot()), verdict
            )

    async def _stream_type(self, hardware_id: str, stream_id: str) -> str:
        if self.list_streams is None:
            return ""
        for item in await self.list_streams(hardware_id):
            if str(item.get("id")) == stream_id:
                return str(item.get("type") or "")
        raise app_error(
            "not_found",
            f"{hardware_id} has no stream {stream_id}",
            {"hardwareId": hardware_id, "streamId": stream_id},
        )

    @contextlib.asynccontextmanager
    async def _probe(
        self, hardware_id: str, stream_id: str
    ) -> AsyncIterator[tuple[StreamStore, StreamRecorder]]:
        path = self.root / f"probe-{uuid.uuid4().hex[:12]}.sqlite"
        store = StreamStore(path)
        recorder = StreamRecorder(
            self.sources,
            store,
            [(hardware_id, stream_id)],
            preroll_ms=0,
            tail_ms=0,
            fetch_blob=self.fetch_blob,
        )
        try:
            await recorder.start()
            yield store, recorder
        finally:
            with contextlib.suppress(Exception):
                await recorder.stop(tail=False)
            store.close()
            _unlink(path)

    async def close(self) -> None:
        feeds, self.feeds = list(self.feeds.values()), {}
        for feed in feeds:
            if feed.closing is not None:
                feed.closing.cancel()
            await self._stop(feed)
        if self._closing:
            await asyncio.gather(*self._closing, return_exceptions=True)

    async def _close(self, feed: _Feed) -> None:
        if self.feeds.get(feed.key) is feed:
            del self.feeds[feed.key]
        await self._stop(feed)

    @staticmethod
    async def _stop(feed: _Feed) -> None:
        with contextlib.suppress(Exception):
            await feed.recorder.stop(tail=False)
        feed.store.close()
        _unlink(feed.path)


def _entry(
    store: StreamStore,
    key: str,
    cursor: _Cursor,
    start: float,
    col: float,
    resume_tb: float | None,
) -> Record | None:
    """The frame entry of one stream, or ``None`` when it has not changed."""
    version = store.version(key)
    if version is None or version == cursor.version:
        return None
    stream_type = str(version[0] or "")
    last_i = version[2]
    first = not cursor.started
    cursor.started = True
    cursor.version = version
    if stream_type in SAMPLED_TYPES:
        if first:
            t0 = math.floor(start / col) * col
            entry = store.window(key, t0, None, col_ms=col, held=True)
            entry["reset"] = resume_tb is None
        elif last_i is not None and last_i != cursor.after:
            earliest = store.earliest_after(key, cursor.after)
            t0 = math.floor(max(start, start if earliest is None else earliest) / col) * col
            entry = store.window(key, t0, None, col_ms=col, held=False)
            entry["reset"] = False
        else:
            return store.head(key, start, None, col_ms=col)
        cursor.after = entry["lastI"]
        return entry
    if first and resume_tb is None and last_i is not None:
        cursor.after = max(0, last_i - FRAME_RECORDS)
    entry = store.window(key, start, None, col_ms=col, after=cursor.after, limit=FRAME_RECORDS)
    if first and resume_tb is not None:
        entry["records"] = [record for record in entry["records"] if record["tb"] > resume_tb]
    if entry["records"]:
        cursor.after = entry["records"][-1]["i"]
    if entry["next"] is not None:
        cursor.version = None  # more waiting: continue next frame
    return entry


def _unlink(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        with contextlib.suppress(OSError):
            Path(f"{path}{suffix}").unlink(missing_ok=True)


def _probe_length(value: float, name: str) -> float:
    length = float(value)
    if not 0 < length <= MAX_PROBE_MS:
        raise app_error(
            "invalid_argument", f"{name} must be in (0, {MAX_PROBE_MS:g}]", {name: value}
        )
    return length


def _seen(store: StreamStore, key: str, t0: float | None, t1: float | None) -> Record:
    info = store.stream(key)
    if str(info["type"] or "") in ("scalar", "block", "bits"):
        return store.read(key, t0=t0, t1=t1, max_points=PROBE_POINTS)
    return store.read(key, t0=t0, t1=t1, limit=PROBE_POINTS)


def _probe_result(
    hardware_id: str,
    stream_id: str,
    store: StreamStore,
    key: str,
    window: judge.Window,
    clock: Record,
    verdict: Record | None,
) -> Record:
    span = window.as_record(clock)
    return {
        "hardwareId": hardware_id,
        "streamId": stream_id,
        "key": key,
        "window": span,
        "clock": clock,
        "verdict": verdict,
        "data": _seen(store, key, span.get("tb0"), span.get("tb1")),
    }
