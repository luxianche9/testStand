"""Read-only data streams a device publishes: ``scalar``, ``bits``, ``bytes``, ``frames``, ``block``, ``blob``.

A stream is declared in ``/device.streams`` by :meth:`Stream.describe`:
``{id, type}`` plus the optional constructor metadata ``unit``, ``width``,
``bitLabels``, ``rateHz`` (sampled streams), ``writable`` (bytes/frames with a
writer), ``idScheme``, ``label`` and ``kind`` (``measured`` or ``setpoint``;
a setpoint stream is the software shadow of a commanded value, never evidence
of the physical output). Records share one :class:`RingBuffer` between the
host's stream reads (:meth:`~.host.DeviceHost.read_stream`) and the stream tools, so viewers,
recorders and AI tools see the same sequence numbers. Record payloads per type (``seq``, ``t`` and optional ``op`` are
added by the SDK):

========  =========================================================
scalar    ``{v}`` number
bits      ``{mask}`` non-negative integer
bytes     ``{dir: tx|rx|mark, data: lowercase hex, note?}``
frames    ``{dir: tx|rx|mark, id, data: lowercase hex, note?}``
block     ``{t0, dt, samples[]}``; ``t0`` equals ``t``, sample i is at ``t0 + i*dt``
blob      ``{ref}``; content through ``<prefix>_blob_read``
========  =========================================================

Adapters only write synchronous functions. Sampled streams get a
``sample`` callable that the SDK polls on its own thread, under the device
``io_lock``, only while somebody watches the stream. Event streams are
published from the adapter's read/write paths; their reader thread calls
``idle()`` after every read return (at least every ``IDLE_INTERVAL_MS``) so
the watermark proves "nothing more arrived until then". A bytes/frames stream
that never calls ``idle()`` keeps a clock-driven watermark, which only holds
when every record is published synchronously by the call that produced it.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any, ClassVar

from .clock import now_ms
from .errors import INVALID_ARGUMENT, NOT_CONFIGURED, NOT_SUPPORTED, DeviceError
from .operation import current
from .ringbuffer import RingBuffer

log = logging.getLogger("hardwareharness_device_sdk.streams")

STREAM_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
STREAM_TYPES = ("scalar", "bits", "bytes", "frames", "block", "blob")
MIN_RATE_HZ, MAX_RATE_HZ = 0.1, 200.0
DIRECTIONS = ("tx", "rx", "mark")
STREAM_KINDS = ("measured", "setpoint")
ID_SCHEMES = ("can", "a429", "m1553", "ieee1394", "raw")
IDLE_INTERVAL_MS = 200
"""Event-stream readers call ``idle()`` at least this often, or mark the stream ``degraded``."""


class Stream:
    """Base class; use one of the typed subclasses."""

    type: ClassVar[str] = ""

    def __init__(self, stream_id: str, *, capacity: int = 4096, max_weight: int | None = None,
                 label: str | None = None, kind: str | None = None) -> None:
        if not STREAM_ID.match(stream_id):
            raise ValueError(f"Invalid streamId {stream_id!r}; use 1-64 of [A-Za-z0-9_.-]")
        if kind is not None and kind not in STREAM_KINDS:
            raise ValueError(f"{stream_id}: kind must be one of {STREAM_KINDS}, got {kind!r}")
        self.stream_id = stream_id
        self.label = label
        self.kind = kind
        self.declaration: dict[str, Any] = {}
        """Type-specific ``describe()`` fields (``unit``, ``width``, ...); ``None`` values are omitted."""
        self.buffer = RingBuffer(capacity, max_weight=max_weight)
        self.sampler: Sampler | None = None
        self._lock = threading.Lock()
        self._state = "live"
        self.errors = 0
        self.last_error: dict[str, Any] | None = None
        self.idle_driven = False
        """An event stream whose reader calls ``idle()``; its watermark stops when the reader stops."""

    # --- records --------------------------------------------------------
    def _append(self, fields: dict[str, Any], *, weight: int = 0, t: float | None = None,
                stamp_key: str | None = None) -> dict[str, Any]:
        op = current()
        if op is not None:
            fields["op"] = op.operation_id
        entry = self.buffer.append(fields, weight=weight, t=t)
        if stamp_key is not None:
            entry[stamp_key] = entry["t"]
        if op is not None:
            op.record(self.stream_id, entry["seq"])
        return entry

    def _sampled(self, value: Any, t: float) -> None:
        raise NotImplementedError

    def present(self, record: dict[str, Any]) -> dict[str, Any]:
        """Record as returned by ``stream_read`` (bytes add decoded ``text`` for AI readers)."""
        return record

    # --- status ---------------------------------------------------------
    def set_state(self, state: str, error: Mapping[str, Any] | None = None) -> None:
        with self._lock:
            self._state = state
            if error is not None:
                self.errors += 1
                self.last_error = {**error, "at": now_ms()}

    def status(self) -> dict[str, Any]:
        with self._lock:
            state = self._state
            result: dict[str, Any] = {"state": state, "sampling": state in {"live", "sampling"},
                                      "errors": self.errors}
            if self.last_error is not None:
                result["lastError"] = dict(self.last_error)
        result["watermark"] = self.buffer.watermark()
        return result

    def describe(self) -> dict[str, Any]:
        """Declaration for ``/device.streams``: ``{id, type}`` plus the metadata that is set."""
        result: dict[str, Any] = {"id": self.stream_id, "type": self.type}
        for key in ("unit", "width", "bitLabels"):
            if self.declaration.get(key) is not None:
                result[key] = self.declaration[key]
        if self.sampler is not None:
            result["rateHz"] = self.sampler.rate_hz
        for key in ("writable", "idScheme"):
            if self.declaration.get(key) is not None:
                result[key] = self.declaration[key]
        if self.label is not None:
            result["label"] = self.label
        if self.kind is not None:
            result["kind"] = self.kind
        return result

    # --- demand ---------------------------------------------------------
    def acquire(self) -> None:
        if self.sampler is not None:
            self.sampler.demand(+1)

    def release(self) -> None:
        if self.sampler is not None:
            self.sampler.demand(-1)

    def close(self) -> None:
        with self._lock:
            self._state = "closed"


def _hex(data: bytes | bytearray | memoryview) -> str:
    return bytes(data).hex()


def _idle(stream: Stream, t: float | None) -> None:
    # From the first call on, the watermark only moves when the reader confirms it (or a record arrives).
    stream.buffer.clocked = False
    stream.idle_driven = True
    stream.buffer.advance(now_ms() if t is None else t)


class ScalarStream(Stream):
    """Numeric readings ``{v}``. Give ``sample`` (returns a number, or ``None`` to skip) to have the SDK poll it."""

    type: ClassVar[str] = "scalar"

    def __init__(self, stream_id: str, *, sample: Callable[[], float | None] | None = None, rate_hz: float = 10.0,
                 capacity: int = 4096, unit: str | None = None, label: str | None = None,
                 kind: str | None = None) -> None:
        super().__init__(stream_id, capacity=capacity, label=label, kind=kind)
        self.declaration["unit"] = unit
        if sample is not None:
            Sampler([self], lambda: [sample()], rate_hz=rate_hz)

    def publish(self, v: float, *, t: float | None = None) -> dict[str, Any]:
        if isinstance(v, bool) or not isinstance(v, int | float):
            raise TypeError(f"{self.stream_id}: scalar value must be a number, got {type(v).__name__}")
        return self._append({"v": float(v)}, t=t)

    def _sampled(self, value: Any, t: float) -> None:
        if value is not None:
            self.publish(value, t=t)


class BitsStream(Stream):
    """Bit masks ``{mask}`` (bit i = line i). ``publish_on_change`` drops sampled masks equal to the last one."""

    type: ClassVar[str] = "bits"

    def __init__(self, stream_id: str, *, sample: Callable[[], int | None] | None = None, rate_hz: float = 10.0,
                 publish_on_change: bool = False, capacity: int = 4096, width: int | None = None,
                 bit_labels: Sequence[str] | None = None, label: str | None = None,
                 kind: str | None = None) -> None:
        super().__init__(stream_id, capacity=capacity, label=label, kind=kind)
        labels = list(bit_labels) if bit_labels is not None else None
        if width is None and labels is not None:
            width = len(labels)
        if width is not None and not 1 <= width <= 64:
            raise ValueError(f"{stream_id}: width must be 1..64, got {width}")
        if labels is not None and len(labels) != width:
            raise ValueError(f"{stream_id}: bit_labels needs one label per bit ({width}), got {len(labels)}")
        self.declaration.update(width=width, bitLabels=labels)
        self.publish_on_change = publish_on_change
        self._last: int | None = None
        if sample is not None:
            Sampler([self], lambda: [sample()], rate_hz=rate_hz)

    def publish(self, mask: int, *, t: float | None = None) -> dict[str, Any]:
        if isinstance(mask, bool) or not isinstance(mask, int) or mask < 0:
            raise TypeError(f"{self.stream_id}: bits mask must be a non-negative integer, got {mask!r}")
        self._last = mask
        return self._append({"mask": mask}, t=t)

    def _sampled(self, value: Any, t: float) -> None:
        if value is None or (self.publish_on_change and value == self._last):
            return
        self.publish(value, t=t)


class ByteStream(Stream):
    """Byte traffic ``{dir, data, note?}``.

    Reader threads call :meth:`rx`. Give ``writer`` (sends bytes, returns the
    count accepted or ``None`` for all) and send through :meth:`send`, which
    records ``tx`` itself; this also enables the generic ``<prefix>_transact``
    tool. :meth:`mark` records configuration events such as a port reset.
    The reader thread calls :meth:`idle` after every read return.
    """

    type: ClassVar[str] = "bytes"

    def __init__(self, stream_id: str, *, writer: Callable[[bytes], int | None] | None = None,
                 capacity: int = 65536, max_bytes: int = 1 << 20, label: str | None = None,
                 kind: str | None = None) -> None:
        super().__init__(stream_id, capacity=capacity, max_weight=max_bytes, label=label, kind=kind)
        self.writer = writer
        self.declaration["writable"] = writer is not None

    def idle(self, t: float | None = None) -> None:
        """Confirm that nothing more arrived up to ``t`` (default: now); advances the watermark."""
        _idle(self, t)

    def _chunk(self, direction: str, data: bytes, note: str | None = None) -> dict[str, Any] | None:
        if not data and note is None:
            return None
        fields: dict[str, Any] = {"dir": direction, "data": _hex(data)}
        if note is not None:
            fields["note"] = note
        return self._append(fields, weight=len(data))

    def rx(self, data: bytes) -> dict[str, Any] | None:
        return self._chunk("rx", bytes(data))

    def tx(self, data: bytes) -> dict[str, Any] | None:
        return self._chunk("tx", bytes(data))

    def mark(self, note: str, data: bytes = b"") -> dict[str, Any]:
        entry = self._chunk("mark", bytes(data), note)
        assert entry is not None
        return entry

    def send(self, data: bytes) -> int:
        if self.writer is None:
            raise DeviceError(f"{self.stream_id} has no writer", category=NOT_SUPPORTED)
        data = bytes(data)
        count = self.writer(data)
        sent = data if count is None else data[:count]
        self.tx(sent)
        return len(sent)

    def present(self, record: dict[str, Any]) -> dict[str, Any]:
        return {**record, "text": bytes.fromhex(record["data"]).decode("utf-8", errors="replace")}


class FrameStream(Stream):
    """Addressed frames ``{dir, id, data, note?}`` (CAN, LIN, SPI transactions). ``writer(id, data)`` enables :meth:`send`."""

    type: ClassVar[str] = "frames"

    def __init__(self, stream_id: str, *, writer: Callable[[int, bytes], Any] | None = None,
                 capacity: int = 16384, id_scheme: str | None = None, label: str | None = None,
                 kind: str | None = None) -> None:
        super().__init__(stream_id, capacity=capacity, label=label, kind=kind)
        if id_scheme is not None and id_scheme not in ID_SCHEMES:
            raise ValueError(f"{stream_id}: id_scheme must be one of {ID_SCHEMES}, got {id_scheme!r}")
        self.writer = writer
        self.declaration.update(writable=writer is not None, idScheme=id_scheme)

    def idle(self, t: float | None = None) -> None:
        """Confirm that nothing more arrived up to ``t`` (default: now); advances the watermark."""
        _idle(self, t)

    def _frame(self, direction: str, frame_id: int, data: bytes, note: str | None = None) -> dict[str, Any]:
        fields: dict[str, Any] = {"dir": direction, "id": int(frame_id), "data": _hex(data)}
        if note is not None:
            fields["note"] = note
        return self._append(fields, weight=len(data))

    def rx(self, frame_id: int, data: bytes) -> dict[str, Any]:
        return self._frame("rx", frame_id, bytes(data))

    def tx(self, frame_id: int, data: bytes) -> dict[str, Any]:
        return self._frame("tx", frame_id, bytes(data))

    def mark(self, note: str) -> dict[str, Any]:
        return self._frame("mark", 0, b"", note)

    def send(self, frame_id: int, data: bytes) -> None:
        if self.writer is None:
            raise DeviceError(f"{self.stream_id} has no writer", category=NOT_SUPPORTED)
        self.writer(int(frame_id), bytes(data))
        self.tx(frame_id, data)


class BlockStream(Stream):
    """Hardware-timed sample blocks ``{t0, dt, samples[]}``.

    ``read_block`` returns ``(samples, dt_ms)`` or ``(samples, dt_ms, t0_ms)``
    (host clock), or ``None`` when no block is ready; without ``t0`` the SDK
    assumes the block ended at the read.
    """

    type: ClassVar[str] = "block"

    def __init__(self, stream_id: str, *, read_block: Callable[[], Any] | None = None, rate_hz: float = 10.0,
                 capacity: int = 256, unit: str | None = None, label: str | None = None,
                 kind: str | None = None) -> None:
        super().__init__(stream_id, capacity=capacity, label=label, kind=kind)
        self.declaration["unit"] = unit
        if read_block is not None:
            Sampler([self], lambda: [read_block()], rate_hz=rate_hz)

    def publish(self, samples: Sequence[float], dt: float, *, t0: float | None = None) -> dict[str, Any]:
        if dt <= 0:
            raise ValueError(f"{self.stream_id}: dt must be positive")
        values = [float(value) for value in samples]
        start = now_ms() - len(values) * dt if t0 is None else t0
        return self._append({"dt": float(dt), "samples": values}, t=start, weight=len(values), stamp_key="t0")

    def _sampled(self, value: Any, t: float) -> None:
        if value is None:
            return
        samples, dt, *rest = value
        self.publish(samples, dt, t0=rest[0] if rest else t - len(samples) * dt)


class BlobStream(Stream):
    """Binary evidence ``{ref}`` (screenshots, photos, log files); content kept in memory up to ``max_bytes``."""

    type: ClassVar[str] = "blob"

    def __init__(self, stream_id: str, *, capacity: int = 64, max_bytes: int = 32 << 20, label: str | None = None,
                 kind: str | None = None) -> None:
        super().__init__(stream_id, capacity=capacity, label=label, kind=kind)
        self.max_bytes = max_bytes
        self._blobs: OrderedDict[str, tuple[str, bytes]] = OrderedDict()
        self._blob_bytes = 0

    def publish(self, data: bytes, mime: str = "application/octet-stream") -> dict[str, Any]:
        data = bytes(data)
        ref = hashlib.sha256(data).hexdigest()
        with self._lock:
            if ref not in self._blobs:
                self._blobs[ref] = (mime, data)
                self._blob_bytes += len(data)
                while self._blob_bytes > self.max_bytes and len(self._blobs) > 1:
                    _, (_, evicted) = self._blobs.popitem(last=False)
                    self._blob_bytes -= len(evicted)
        return self._append({"ref": ref})

    def read(self, ref: str) -> tuple[str, bytes]:
        with self._lock:
            item = self._blobs.get(ref)
        if item is None:
            raise DeviceError(f"Unknown or evicted blob ref {ref!r}", category=INVALID_ARGUMENT)
        return item


class Sampler:
    """Polls ``sample()`` on a dedicated thread while any of its streams has demand.

    ``sample`` returns one value per stream (a scan group shares one ``t``);
    ``None`` skips that stream. Each attempt runs under the device ``io_lock``
    and advances every stream's watermark, including failed attempts, so a
    consumer waiting on the stream learns quickly that no data is coming.
    ``DeviceError(category="not_configured")`` marks the streams
    ``not_configured`` without counting an error.
    """

    def __init__(self, streams: Sequence[Stream], sample: Callable[[], Sequence[Any]], *,
                 rate_hz: float = 10.0) -> None:
        if not streams:
            raise ValueError("Sampler needs at least one stream")
        self.streams = list(streams)
        self.sample = sample
        self.rate_hz = min(MAX_RATE_HZ, max(MIN_RATE_HZ, float(rate_hz)))
        self._cond = threading.Condition()
        self._demand = 0
        self._closed = False
        self._thread: threading.Thread | None = None
        self._available: Callable[[], bool] = lambda: True
        self._io_lock: Any = threading.RLock()
        for stream in self.streams:
            if stream.sampler is not None and stream.sampler is not self:
                raise ValueError(f"{stream.stream_id} already has a sampler")
            stream.sampler = self
            stream.buffer.clocked = False
            stream.set_state("idle")

    def bind(self, available: Callable[[], bool], io_lock: Any) -> None:
        self._available, self._io_lock = available, io_lock
        with self._cond:
            self._closed = False
            if self._thread is None or not self._thread.is_alive():
                name = f"sampler:{','.join(stream.stream_id for stream in self.streams[:3])}"
                self._thread = threading.Thread(target=self._run, name=name, daemon=True)
                self._thread.start()

    def demand(self, delta: int) -> None:
        with self._cond:
            self._demand = max(0, self._demand + delta)
            self._cond.notify_all()

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        for stream in self.streams:
            stream.close()

    def _set_all(self, state: str, error: Mapping[str, Any] | None = None) -> None:
        for stream in self.streams:
            stream.set_state(state, error)

    def _advance(self, t: float) -> None:
        for stream in self.streams:
            stream.buffer.advance(t)

    def _run(self) -> None:
        period = 1.0 / self.rate_hz
        deadline = time.perf_counter()
        while True:
            with self._cond:
                if self._demand == 0 and not self._closed:
                    self._set_all("idle")
                    while self._demand == 0 and not self._closed:
                        self._cond.wait()
                    deadline = time.perf_counter()
                if self._closed:
                    return
                delay = deadline - time.perf_counter()
                if delay > 0:
                    self._cond.wait(delay)
                    if self._closed:
                        return
                    if time.perf_counter() < deadline:
                        continue
            deadline = max(deadline + period, time.perf_counter())
            self._attempt()

    def _attempt(self) -> None:
        if not self._available():
            self._set_all("unavailable")
            self._advance(now_ms())
            return
        with self._io_lock:
            start = now_ms()
            try:
                values = list(self.sample())
                if len(values) != len(self.streams):
                    raise DeviceError(f"sample() returned {len(values)} values for {len(self.streams)} streams",
                                      category="internal")
                t = round((start + now_ms()) / 2, 3)
                for stream, value in zip(self.streams, values, strict=True):
                    stream._sampled(value, t)  # noqa: SLF001
                    stream.set_state("sampling" if value is not None else "not_configured")
            except DeviceError as exc:
                if exc.category == NOT_CONFIGURED:
                    self._set_all("not_configured")
                else:
                    self._set_all("error", {"category": exc.category, "message": str(exc)})
            except Exception as exc:
                if self.streams[0].errors % 100 == 0:
                    log.exception("Sampling %s failed", self.streams[0].stream_id)
                self._set_all("error", {"category": "internal", "message": str(exc)})
            finally:
                self._advance(now_ms())


class StreamRegistry(Mapping[str, Stream]):
    def __init__(self) -> None:
        self._streams: dict[str, Stream] = {}

    def add(self, stream: Stream) -> Any:
        if stream.type not in STREAM_TYPES:
            raise TypeError(f"{stream.stream_id}: use a typed stream class, not {type(stream).__name__}")
        if stream.stream_id in self._streams:
            raise ValueError(f"Duplicate streamId {stream.stream_id}")
        self._streams[stream.stream_id] = stream
        return stream

    def scan(self, streams: Sequence[Stream], sample: Callable[[], Sequence[Any]], *, rate_hz: float = 10.0) -> Sampler:
        """One ``sample()`` call feeding several already-added streams with a shared ``t`` (multi-channel scan)."""
        for stream in streams:
            if self._streams.get(stream.stream_id) is not stream:
                raise ValueError(f"Add {stream.stream_id} to the registry before scanning it")
        return Sampler(streams, sample, rate_hz=rate_hz)

    def require(self, stream_id: str) -> Stream:
        stream = self._streams.get(stream_id)
        if stream is None:
            raise DeviceError(f"Unknown streamId {stream_id!r}; read /device streams for exact identifiers",
                              category=INVALID_ARGUMENT, details={"known": sorted(self._streams)})
        return stream

    def __getitem__(self, stream_id: str) -> Stream:
        return self._streams[stream_id]

    def __iter__(self) -> Iterator[str]:
        return iter(self._streams)

    def __len__(self) -> int:
        return len(self._streams)

    def samplers(self) -> list[Sampler]:
        seen: dict[int, Sampler] = {}
        for stream in self._streams.values():
            if stream.sampler is not None:
                seen.setdefault(id(stream.sampler), stream.sampler)
        return list(seen.values())

    def describe(self) -> list[dict[str, Any]]:
        return [stream.describe() for stream in self._streams.values()]

    def bind(self, available: Callable[[], bool], io_lock: Any) -> None:
        for stream in self._streams.values():
            if stream.sampler is None:
                stream.set_state("live")
        for sampler in self.samplers():
            sampler.bind(available, io_lock)

    def close(self) -> None:
        for sampler in self.samplers():
            sampler.close()
        for stream in self._streams.values():
            stream.close()
