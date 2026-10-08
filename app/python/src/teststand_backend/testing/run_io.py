"""Per-run device I/O: the stream recording, anchors and stream verdicts.

A run records every declared stream of the hardware it touches into the run's
``runs/<runId>/run.sqlite`` and judges ``Observe`` / ``Expect`` / ``Guard`` steps from
that recording only, so ``rejudge`` over the same file reproduces each verdict.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Callable
from pathlib import Path
from typing import Any

from teststand_backend.contracts.errors import app_error
from teststand_backend.streams import judge
from teststand_backend.streams.clock import backend_ms
from teststand_backend.streams.data import StreamData, stream_key
from teststand_backend.streams.judge import Anchor, GuardWatch, Window
from teststand_backend.streams.recorder import StreamRecorder
from teststand_backend.streams.source import StreamSources
from teststand_backend.streams.store import StreamStore

from .journal import RUN_FILE
from .models import step_verdict
from .protocols import DerivedRef, PlanProtocols, derived_data, live_decoder

Record = dict[str, Any]
Emit = Callable[[str, Record], None]

log = logging.getLogger(__name__)

WATERMARK_GRACE_S = 2.0
EXPECT_POLL_S = 0.2
BACKEND = "__backend__"


class RunIO:
    def __init__(
        self,
        devices: Any,
        sources: StreamSources | None,
        run_dir: Path,
        run_id: str,
        emit: Emit,
    ) -> None:
        self.devices, self.sources = devices, sources
        self.run_dir, self.run_id, self.emit = run_dir, run_id, emit
        self._locks: dict[str, asyncio.Lock] = {}
        self.anchors: dict[str, Anchor] = {}
        self.stream_types: dict[str, str] = {}
        self.descriptors: dict[str, Record] = {}
        self.protocols = PlanProtocols({}, [])
        self.store: StreamStore | None = None
        self.recorder: StreamRecorder | None = None

    # -- lifecycle -----------------------------------------------------------------------------

    async def start(self, hardware_ids: list[str], protocols: PlanProtocols | None = None) -> None:
        """Start recording the streams of ``hardware_ids``."""
        if protocols is not None:
            self.protocols = protocols
        try:
            if self.sources is not None:
                await self._record(hardware_ids)
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        if self.recorder is not None:
            try:
                await self.recorder.stop()
            except Exception:
                log.exception("Stopping the stream recording failed")
        if self.store is not None:
            self.store.close()

    async def _record(self, hardware_ids: list[str]) -> None:
        assert self.sources is not None
        streams: list[tuple[str, str]] = []
        list_streams = getattr(self.devices, "list_streams", None)
        for hardware_id in hardware_ids:
            if list_streams is None:
                break
            try:
                declared = await list_streams(hardware_id)
            except Exception as error:
                self.emit("streams.unavailable", {"hardwareId": hardware_id, "message": str(error)})
                continue
            for item in declared:
                streams.append((hardware_id, str(item["id"])))
                key = stream_key(hardware_id, str(item["id"]))
                self.stream_types[key] = str(item["type"])
                self.descriptors[key] = dict(item)
        self.store = StreamStore(self.run_dir / RUN_FILE)
        # Descriptors grade the evidence (§7.7); the frozen ICDs re-decode derived streams (§6.4).
        self.store.set_meta(
            runId=self.run_id, descriptors=self.descriptors, protocols=self.protocols.snapshot()
        )
        fetch_blob = getattr(self.devices, "read_blob", None)
        self.recorder = StreamRecorder(self.sources, self.store, streams, fetch_blob=fetch_blob)
        await self.recorder.start()
        self.emit(
            "recording.started",
            {
                "streams": [
                    stream_key(hardware_id, stream_id) for hardware_id, stream_id in streams
                ],
            },
        )

    # -- calls and anchors ---------------------------------------------------------------------

    def device_lock(self, hardware_id: str) -> asyncio.Lock:
        return self._locks.setdefault(hardware_id, asyncio.Lock())

    def clock_snapshot(self, hardware_id: str) -> Record:
        clock = self.sources.clock(hardware_id) if self.sources is not None else None
        return dict(clock.snapshot()) if clock is not None and clock.known else {}

    def timing(
        self, hardware_id: str, backend_start: float, backend_end: float, meta: Record | None
    ) -> Record:
        """Both clocks of one call: backend always, service time when the service reported it."""
        timing: Record = {
            "backendStart": round(backend_start, 3),
            "backendEnd": round(backend_end, 3),
        }
        service = (meta or {}).get("timing") or {}
        for name, field in (("serverStart", "start"), ("serverEnd", "end")):
            if isinstance(service.get(field), (int, float)):
                timing[name] = float(service[field])
        clock = self.clock_snapshot(hardware_id)
        if clock and "serverEnd" in timing:
            timing["clockUncertaintyMs"] = clock.get("uncertaintyMs")
        return timing

    def set_anchor(self, name: str, hardware_id: str, timing: Record) -> Record:
        if isinstance(timing.get("serverEnd"), (int, float)):
            anchor = Anchor(
                float(timing["serverEnd"]), hardware_id, self.clock_snapshot(hardware_id)
            )
        else:
            start, end = float(timing["backendStart"]), float(timing["backendEnd"])
            anchor = Anchor(end, BACKEND, {"offsetMs": 0.0, "uncertaintyMs": end - start})
        self.anchors[name] = anchor
        return {
            "name": name,
            "t": anchor.t,
            "hardwareId": anchor.hardware_id,
            "clock": anchor.clock,
        }

    def anchor(self, name: str) -> Anchor:
        anchor = self.anchors.get(name)
        if anchor is None:
            raise app_error(
                "invalid_argument", f"Anchor {name!r} is not defined yet", {"anchor": name}
            )
        return anchor

    # -- stream verdicts -----------------------------------------------------------------------

    def _source(self, hardware_id: str, stream_id: str) -> str:
        """The recorded stream behind ``stream_id``: itself, or a derived stream's raw source."""
        derived = self.protocols.derived(hardware_id, stream_id)
        return derived.binding.stream_id if derived is not None else stream_id

    def _require_stream(
        self, hardware_id: str, stream_id: str, check: Callable[[str], str | None]
    ) -> tuple[StreamStore, str]:
        """The recording of one stream, after checking the step's spec against its type."""
        key = stream_key(hardware_id, stream_id)
        derived = self.protocols.derived(hardware_id, stream_id)
        if self.store is None or self.recorder is None:
            raise app_error("unavailable", "This run has no stream recording", {"stream": key})
        if self.recorder.track(hardware_id, self._source(hardware_id, stream_id)) is None:
            raise app_error(
                "not_found",
                f"Stream {key} is not recorded in this run",
                {"hardwareId": hardware_id, "streamId": stream_id},
            )
        stream_type = derived.stream.stream_type if derived else self.stream_types.get(key, "")
        message = check(stream_type)
        if message:
            raise app_error(
                "invalid_argument",
                f"{key}: {message}",
                {"hardwareId": hardware_id, "streamId": stream_id},
            )
        return self.store, key

    def _stream_clock(self, hardware_id: str, stream_id: str) -> Record:
        source = self._source(hardware_id, stream_id)
        clock = self.recorder.clock(hardware_id, source) if self.recorder else None
        return dict(clock.snapshot()) if clock is not None and clock.known else {}

    def _now(self, hardware_id: str, stream_id: str) -> float | None:
        """The stream's service clock now, if known."""
        source = self._source(hardware_id, stream_id)
        clock = self.recorder.clock(hardware_id, source) if self.recorder else None
        return clock.to_server(backend_ms()) if clock is not None and clock.known else None

    async def _wait_watermark(
        self, hardware_id: str, stream_id: str, t: float, timeout: float
    ) -> None:
        assert self.recorder is not None
        await self.recorder.wait_watermark(
            hardware_id, self._source(hardware_id, stream_id), t, timeout
        )

    def _data(self, store: StreamStore, key: str, window: Window) -> StreamData:
        return read_data(store, key, window, self.protocols, self.descriptors)

    def _wait_s(self, hardware_id: str, stream_id: str, t1: float, fallback_ms: float) -> float:
        now = self._now(hardware_id, stream_id)
        ahead = (t1 - now) if now is not None else fallback_ms
        return max(0.0, ahead) / 1000 + WATERMARK_GRACE_S

    async def observe(
        self,
        hardware_id: str,
        stream_id: str,
        window_spec: Record,
        assertions: list[Record],
        min_samples: int,
    ) -> tuple[Record, Record]:
        def check(stream_type: str) -> str | None:
            if not assertions:
                return "Observe needs at least one assertion"
            for assertion in assertions:
                message = judge.assertion_error(assertion) or judge.metric_error(
                    stream_type, str(assertion["metric"])
                )
                if message:
                    return message
            return None

        store, key = self._require_stream(hardware_id, stream_id, check)
        start_ms, end_ms = float(window_spec.get("startMs", 0)), float(window_spec["endMs"])
        window = judge.map_window(
            self.anchor(str(window_spec["anchor"])),
            hardware_id,
            self._stream_clock(hardware_id, stream_id),
            start_ms,
            end_ms,
        )
        if math.isfinite(window.t1):
            await self._wait_watermark(
                hardware_id,
                stream_id,
                window.t1,
                self._wait_s(hardware_id, stream_id, window.t1, end_ms),
            )
        verdict = judge.observe(
            self._data(store, key, window), window, assertions, min_samples=min_samples
        )
        spec = {"type": "observe", "assertions": assertions, "minSamples": min_samples}
        return self._spec(spec, hardware_id, stream_id, window), verdict

    async def expect(
        self,
        hardware_id: str,
        stream_id: str,
        anchor_name: str,
        offset_ms: float,
        within_ms: float,
        match: Record,
    ) -> tuple[Record, Record]:
        store, key = self._require_stream(
            hardware_id, stream_id, lambda stream_type: judge.match_error(stream_type, match)
        )
        window = judge.map_window(
            self.anchor(anchor_name),
            hardware_id,
            self._stream_clock(hardware_id, stream_id),
            offset_ms,
            offset_ms + within_ms,
            shrink=False,
        )
        deadline = backend_ms() + 1000 * (
            self._wait_s(hardware_id, stream_id, window.t1, offset_ms + within_ms)
            if math.isfinite(window.t1)
            else 0.0
        )
        while True:
            verdict = judge.expect(self._data(store, key, window), window, match)
            remaining = (deadline - backend_ms()) / 1000
            if (
                verdict["verdict"] == judge.PASS
                or verdict.get("reason") != "watermark_timeout"
                or remaining <= 0
            ):
                break
            await store.wait_change(min(remaining, EXPECT_POLL_S))
        spec = {"type": "expect", "match": match}
        return self._spec(spec, hardware_id, stream_id, window), verdict

    def guard(self, hardware_id: str, stream_id: str, condition: Record) -> GuardSession:
        store, key = self._require_stream(
            hardware_id,
            stream_id,
            lambda stream_type: judge.match_error(stream_type, condition, condition=True),
        )
        return GuardSession(self, store, key, hardware_id, stream_id, condition)

    def _spec(self, spec: Record, hardware_id: str, stream_id: str, window: Window) -> Record:
        derived = self.protocols.derived(hardware_id, stream_id)
        if derived is not None:
            spec = {**spec, "protocol": _protocol_spec(derived)}
        return {
            **spec,
            "key": stream_key(hardware_id, stream_id),
            "hardwareId": hardware_id,
            "streamId": stream_id,
            "window": {
                "t0": window.t0,
                "t1": window.t1,
                "uncertaintyMs": window.uncertainty_ms,
                "warnings": list(window.warnings),
            },
        }


class GuardSession:
    """One ``Guard`` block: watch the stream live, then judge the whole span offline."""

    def __init__(
        self,
        io: RunIO,
        store: StreamStore,
        key: str,
        hardware_id: str,
        stream_id: str,
        condition: Record,
    ) -> None:
        self.io, self.store, self.key = io, store, key
        self.hardware_id, self.stream_id, self.condition = hardware_id, stream_id, condition
        self.derived = io.protocols.derived(hardware_id, stream_id)
        self.source_key = self.derived.binding.source_key if self.derived else key
        self.t0: float | None = None
        self._queue: asyncio.Queue[Record] | None = None

    def begin(self) -> bool:
        """Start watching; ``False`` if the stream's clock is unknown (no span to guard)."""
        assert self.io.recorder is not None
        self._queue = self.io.recorder.listen(self.source_key)
        self.t0 = self.io._now(self.hardware_id, self.stream_id)
        return self.t0 is not None

    async def watch(self) -> Record | None:
        """Return the first violation seen live (``None`` once the recording ends)."""
        assert self._queue is not None and self.t0 is not None
        if self.derived is not None:
            return await self._watch_derived(self.derived, self._queue, self.t0)
        # The declared type: the recording only learns it from the stream's first hello.
        stream_type = self.io.stream_types.get(self.key) or str(
            self.store.stream(self.key)["type"] or ""
        )
        watcher = GuardWatch(stream_type, self.condition)
        if stream_type in {"scalar", "block", "bits"}:
            before = self.store.stream_data(self.key, self.t0, self.t0).records
            held = [record for record in before if record["t"] <= self.t0]
            violation = watcher.prime(held[-1] if held else None)
            if violation is not None:
                return violation
        while True:
            frame = await self._queue.get()
            if frame["type"] == "end":
                return None
            if frame["type"] != "batch":
                continue
            for record in frame["records"]:
                if float(record["t"]) > self.t0:
                    violation = watcher.feed(record)
                    if violation is not None:
                        return violation

    async def _watch_derived(
        self, derived: DerivedRef, queue: asyncio.Queue[Record], t0: float
    ) -> Record | None:
        """Decode the raw source live: replay what is recorded, then follow new batches."""
        watcher = GuardWatch(derived.stream.stream_type, self.condition)
        feed = live_decoder(derived)
        recorded = self.store.records(self.source_key)
        last_i = max((int(record["i"]) for record in recorded), default=-1)
        held = [record for record in feed(recorded) if float(record["t"]) <= t0]
        if derived.stream.stream_type == "scalar":
            violation = watcher.prime(held[-1] if held else None)
            if violation is not None:
                return violation
        while True:
            frame = await queue.get()
            if frame["type"] == "end":
                return None
            if frame["type"] == "gap":
                feed(None)
                continue
            if frame["type"] != "batch":
                continue
            fresh = [record for record in frame["records"] if int(record.get("i", 0)) > last_i]
            last_i = max((int(record.get("i", 0)) for record in fresh), default=last_i)
            for record in feed(fresh):
                if float(record["t"]) > t0:
                    violation = watcher.feed(record)
                    if violation is not None:
                        return violation

    async def finish(self) -> tuple[Record, Record]:
        """Judge ``[t0, now]`` from the recording once the watermark covers it."""
        assert self.io.recorder is not None
        if self._queue is not None:
            self.io.recorder.unlisten(self.source_key, self._queue)
        t0 = self.t0 if self.t0 is not None else math.nan
        now = self.io._now(self.hardware_id, self.stream_id)
        t1 = now if now is not None else math.nan
        window = Window(t0, t1)
        if math.isfinite(t0) and math.isfinite(t1):
            await self.io._wait_watermark(self.hardware_id, self.stream_id, t1, WATERMARK_GRACE_S)
            verdict = judge.guard(
                self.io._data(self.store, self.key, window), window, self.condition
            )
        else:
            verdict = judge._verdict(
                judge.INCONCLUSIVE,
                {"condition": self.condition},
                "clock_uncertainty",
                "the stream's clock offset is unknown",
            )
        spec = {"type": "guard", "condition": self.condition}
        return self.io._spec(spec, self.hardware_id, self.stream_id, window), verdict


def read_data(
    store: StreamStore,
    key: str,
    window: Window,
    protocols: PlanProtocols,
    descriptors: dict[str, Record],
) -> StreamData:
    """Judge input for one stream key over ``window``, raw or derived (decoded from its source).

    Shared by the live verdicts and :func:`rejudge`, so both read exactly the same data.
    """
    derived = protocols.derived_by_key(key)
    source_key = derived.binding.source_key if derived is not None else key
    descriptor = derived.descriptor if derived is not None else descriptors.get(key) or {}
    if not (math.isfinite(window.t0) and math.isfinite(window.t1)):
        info = store.stream(source_key)
        stream_type = derived.stream.stream_type if derived else str(info["type"] or "")
        if derived is None:
            descriptor = {**store.declaration(source_key), **descriptor}
        return StreamData(stream_type, [], clock=info["clock"] or {}, descriptor=descriptor)
    source = store.stream_data(source_key, window.t0, window.t1)
    if derived is None:
        source.descriptor = {**source.descriptor, **descriptor}
        return source
    raw = store.records(source_key, hi=window.t1)
    return derived_data(derived, raw, source, window.t0, window.t1)


def _protocol_spec(derived: DerivedRef) -> Record:
    return {
        "alias": derived.binding.alias,
        "icd": derived.binding.icd.name,
        "icdHash": derived.binding.icd_hash,
        "source": derived.binding.source_key,
    }


def rejudge(results: list[Record], path: Path | None) -> list[Record]:
    """Recompute every recorded stream verdict from the run's recording (pure, read-only).

    Derived streams are re-decoded from the recorded raw data with the ICDs frozen in the
    recording, never with the project's current ICD files (§6.4).
    """
    output: list[Record] = []
    store = StreamStore(path, readonly=True) if path is not None else None
    try:
        meta = store.meta() if store is not None else {}
        protocols = PlanProtocols.from_snapshot(meta.get("protocols"))
        descriptors = meta.get("descriptors")
        context = (protocols, descriptors if isinstance(descriptors, dict) else {})
        for result in results:
            spec = result.get("judge")
            if result.get("kind") != "verdict" or not isinstance(spec, dict):
                continue
            recomputed = rejudge_one(spec, store, context)
            output.append(
                {
                    "sequence": result.get("sequence"),
                    "sourceStepId": result.get("sourceStepId"),
                    "executionId": result.get("executionId"),
                    "recorded": result.get("verdict"),
                    "rejudged": step_verdict(recomputed),
                    "result": recomputed,
                    "same": step_verdict(recomputed) == result.get("verdict"),
                }
            )
    finally:
        if store is not None:
            store.close()
    return output


def rejudge_one(
    spec: Record,
    store: StreamStore | None,
    context: tuple[PlanProtocols, dict[str, Record]] | None = None,
) -> Record:
    kind = spec.get("type")
    if kind == "result":
        return judge.check_result(spec.get("value"), list(spec.get("assertions", [])))
    raw = spec.get("window") or {}
    t0, t1 = _number(raw.get("t0")), _number(raw.get("t1"))
    window = Window(
        t0, t1, float(raw.get("uncertaintyMs") or 0.0), tuple(raw.get("warnings") or ())
    )
    if store is None:
        return judge._verdict(
            judge.INCONCLUSIVE, {}, "insufficient_evidence", "the run has no stream recording"
        )
    protocols, descriptors = context or (PlanProtocols({}, []), {})
    data = read_data(store, str(spec["key"]), window, protocols, descriptors)
    if kind == "observe":
        return judge.observe(
            data,
            window,
            list(spec.get("assertions", [])),
            min_samples=int(spec.get("minSamples", judge.MIN_SAMPLES)),
        )
    if kind == "expect":
        return judge.expect(data, window, dict(spec.get("match") or {}))
    if kind == "guard":
        if not (math.isfinite(t0) and math.isfinite(t1)):
            return judge._verdict(
                judge.INCONCLUSIVE,
                {"condition": spec.get("condition")},
                "clock_uncertainty",
                "the stream's clock offset is unknown",
            )
        return judge.guard(data, window, dict(spec.get("condition") or {}))
    raise app_error("invalid_argument", f"Unknown judge type {kind!r}")


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else math.nan
