"""StreamRecorder: follow a set of device streams over SSE into one :class:`StreamStore`.

Used for run recordings (every stream of the plan's hardware, from a pre-roll
before the run to a tail after it) and for the device page's live view. Besides
writing, a recorder lets the engine wait until a stream's watermark covers a
time (so a verdict never judges data that has not arrived) and listen to the
records as they come in (``Guard``).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
from collections.abc import Awaitable, Callable

from hardwareharness_backend.util import Record

from .clock import SHARED_CLOCK, SharedClock, backend_ms
from .data import stream_key
from .source import StreamSource, StreamSources
from .store import StreamStore

log = logging.getLogger("hardwareharness_backend.streams.recorder")

PREROLL_MS = 1000.0
TAIL_MS = 500.0
STOP_TIMEOUT = 2.0

BlobFetcher = Callable[[str, str, str], Awaitable[Record]]
"""``(hardwareId, streamId, ref) -> {mime, base64}`` (the service's ``blob_read`` tool)."""


class _Track:
    """One recorded stream."""

    def __init__(self, recorder: StreamRecorder, hardware_id: str, stream_id: str) -> None:
        self.recorder = recorder
        self.hardware_id, self.stream_id = hardware_id, stream_id
        self.key = stream_key(hardware_id, stream_id)
        self.stream_type: str | None = None
        self.source: StreamSource | None = None
        self.task: asyncio.Task[None] | None = None
        self.watermark: float | None = None
        self.watermark_tb: float | None = None
        self.ended = False
        self.listeners: list[asyncio.Queue[Record]] = []
        self._state: tuple[str, str | None] | None = None
        self._clock: Record | None = None
        self._blobs: set[str] = set()
        self._progress = asyncio.Condition()

    @property
    def store(self) -> StreamStore:
        return self.recorder.store

    async def run(self, source: StreamSource) -> None:
        self.source = source
        try:
            async for event in source.events():
                await self._handle(event)
        finally:
            self.ended = True
            await self._notify()

    async def _handle(self, event: Record) -> None:
        kind = event["type"]
        if kind == "hello":
            self.stream_type = event["streamType"]
            self.store.update_stream(self.key, stream_type=self.stream_type)
            self.note_state("connected")
        elif kind == "batch":
            watermark_tb = self._to_backend(event.get("watermark"))
            records: list[Record] = event["records"]
            if records:
                ids = self.store.append(
                    self.key, records, watermark=event.get("watermark"), watermark_tb=watermark_tb
                )
                for i, record in zip(ids, records, strict=True):
                    record["i"] = i
                    if self.stream_type == "blob" and isinstance(record.get("ref"), str):
                        self.recorder._fetch_blob(self, record["ref"])
                self._emit(
                    {
                        "type": "batch",
                        "records": records,
                        "watermark": event.get("watermark"),
                        "watermarkTb": watermark_tb,
                    }
                )
            await self._advance(event.get("watermark"), watermark_tb)
        elif kind == "gap":
            gap = {key: event.get(key) for key in ("reason", "fromSeq", "toSeq", "t0", "t1")}
            gap["tb"] = self._to_backend(gap["t0"])
            self.store.add_gap(self.key, gap)
            self._emit({"type": "gap", **gap})
        elif kind == "status":
            last_error = event.get("lastError")
            message = last_error.get("message") if isinstance(last_error, dict) else None
            self.note_state(str(event.get("state")), message)
            await self._advance(event.get("watermark"), self._to_backend(event.get("watermark")))
        elif kind == "state":
            self.note_state(event["state"], event.get("message"))
        self._sync_clock()

    def note_state(self, state: str, message: str | None = None) -> None:
        if self._state == (state, message):
            return
        self._state = (state, message)
        self.store.add_state(self.key, round(backend_ms(), 3), state, message)
        self._emit({"type": "state", "state": state, "message": message})

    def _to_backend(self, t: object) -> float | None:
        if not isinstance(t, (int, float)):
            return None
        return round(SHARED_CLOCK.to_backend(float(t)), 3)

    def _sync_clock(self) -> None:
        snapshot: Record = dict(SHARED_CLOCK.snapshot())
        if snapshot != self._clock:
            self._clock = snapshot
            self.store.update_stream(self.key, clock=snapshot)

    async def _advance(self, watermark: object, watermark_tb: float | None) -> None:
        if not isinstance(watermark, (int, float)) or (
            self.watermark is not None and watermark <= self.watermark
        ):
            return
        self.watermark, self.watermark_tb = float(watermark), watermark_tb
        self.store.update_stream(self.key, watermark=self.watermark, watermark_tb=watermark_tb)
        await self._notify()

    async def _notify(self) -> None:
        async with self._progress:
            self._progress.notify_all()

    async def wait_until(self, reached: Callable[[], bool], timeout: float) -> bool:
        async def wait() -> None:
            async with self._progress:
                await self._progress.wait_for(lambda: self.ended or reached())

        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(wait(), timeout)
        return reached()

    async def wait_backend(self, tb: float, timeout: float) -> bool:
        return await self.wait_until(
            lambda: self.watermark_tb is not None and self.watermark_tb >= tb, timeout
        )

    def _emit(self, frame: Record) -> None:
        for queue in list(self.listeners):
            queue.put_nowait(frame)


class StreamRecorder:
    def __init__(
        self,
        sources: StreamSources,
        store: StreamStore,
        streams: list[tuple[str, str]],
        *,
        preroll_ms: float = PREROLL_MS,
        tail_ms: float = TAIL_MS,
        fetch_blob: BlobFetcher | None = None,
    ) -> None:
        self.sources = sources
        self.store = store
        self.preroll_ms, self.tail_ms = preroll_ms, tail_ms
        self.fetch_blob = fetch_blob
        self.tracks: dict[str, _Track] = {}
        self._pending = list(dict.fromkeys(streams))
        self.started_tb: float | None = None
        self.active = False
        self._blob_tasks: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        self.started_tb = round(backend_ms(), 3)
        self.store.set_meta(
            preRollMs=self.preroll_ms,
            tailMs=self.tail_ms,
            startedTb=self.started_tb,
            stoppedTb=None,
            recording=True,
        )
        self.active = True
        pending, self._pending = self._pending, []
        for hardware_id, stream_id in pending:
            self.add(hardware_id, stream_id, since=self.started_tb - self.preroll_ms)

    def add(self, hardware_id: str, stream_id: str, *, since: float | None = None) -> _Track:
        """Start recording one more stream (``since``: backend time, default = from now)."""
        key = stream_key(hardware_id, stream_id)
        existing = self.tracks.get(key)
        if existing is not None:
            return existing
        track = _Track(self, hardware_id, stream_id)
        self.tracks[key] = track
        self.store.add_stream(hardware_id, stream_id)
        try:
            source = self.sources.source(hardware_id, stream_id, since=since)
        except Exception as exc:
            log.warning("Cannot record %s: %s", key, exc)
            track.note_state("unavailable", str(exc))
            track.ended = True
            return track
        track.task = asyncio.create_task(track.run(source), name=f"record:{key}")
        return track

    def track(self, hardware_id: str, stream_id: str) -> _Track | None:
        return self.tracks.get(stream_key(hardware_id, stream_id))

    def clock(self, hardware_id: str, stream_id: str) -> SharedClock:
        """Every device shares the backend clock."""
        return SHARED_CLOCK

    async def wait_watermark(
        self, hardware_id: str, stream_id: str, t: float, timeout: float
    ) -> bool:
        """Wait until the recording covers service time ``t`` for this stream."""
        track = self.track(hardware_id, stream_id)
        if track is None:
            return False
        return await track.wait_until(
            lambda: track.watermark is not None and track.watermark >= t, timeout
        )

    def listen(self, key: str) -> asyncio.Queue[Record] | None:
        """Frames of one stream as they are recorded: ``batch`` (records with ``i``), ``gap``,
        ``state``, then ``end``."""
        track = self.tracks.get(key)
        if track is None:
            return None
        queue: asyncio.Queue[Record] = asyncio.Queue()
        track.listeners.append(queue)
        if not self.active:
            queue.put_nowait({"type": "end"})
        return queue

    def unlisten(self, key: str, queue: asyncio.Queue[Record]) -> None:
        track = self.tracks.get(key)
        if track is not None and queue in track.listeners:
            track.listeners.remove(queue)

    async def stop(self, timeout: float = STOP_TIMEOUT, *, tail: bool = True) -> None:
        """Record the tail, then close every source and finish the store's metadata."""
        if not self.active:
            return
        if tail and self.tail_ms > 0:
            end_tb = backend_ms() + self.tail_ms
            await asyncio.sleep(self.tail_ms / 1000)
            await asyncio.gather(
                *(
                    track.wait_backend(end_tb, timeout)
                    for track in self.tracks.values()
                    if not track.ended
                )
            )
        tasks = [track.task for track in self.tracks.values() if track.task is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if self._blob_tasks:
            await asyncio.wait(self._blob_tasks, timeout=timeout)
        self.active = False
        self.store.set_meta(stoppedTb=round(backend_ms(), 3), recording=False)
        for track in self.tracks.values():
            track._emit({"type": "end"})

    # -- blobs -----------------------------------------------------------------------------

    def _fetch_blob(self, track: _Track, ref: str) -> None:
        if self.fetch_blob is None or ref in track._blobs:
            return
        track._blobs.add(ref)
        task = asyncio.create_task(self._store_blob(track, ref))
        self._blob_tasks.add(task)
        task.add_done_callback(self._blob_tasks.discard)

    async def _store_blob(self, track: _Track, ref: str) -> None:
        assert self.fetch_blob is not None
        try:
            blob = await self.fetch_blob(track.hardware_id, track.stream_id, ref)
            content = base64.b64decode(blob["base64"])
        except Exception as exc:
            log.warning("Blob %s of %s not stored: %s", ref, track.key, exc)
            return
        if not self.store.closed:
            mime = str(blob.get("mime") or "application/octet-stream")
            self.store.put_blob(track.key, ref, mime, content)
