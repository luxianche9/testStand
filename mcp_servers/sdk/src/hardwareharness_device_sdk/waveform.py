"""Low-rate software waveforms for static outputs (DEC-06: generated next to the hardware).

A :class:`SoftwareWaveform` runs one generator thread per device while any
channel is active. The phase is computed from the service clock relative to
``startAt`` (``t - startAt``), never accumulated per tick, so it does not
drift; late ticks are skipped instead of bursting. Every write runs under the
device ``io_lock`` and every written value is published to the channel's
``kind="setpoint"`` scalar stream: the software shadow of the command, never
evidence of the physical output (measure it independently).

Adapters declare the capability with :func:`waveform_capability`, expose
``set_waveform``/``stop_waveform`` tools that delegate here and call
:meth:`SoftwareWaveform.stop_all` in ``safe_state``::

    self.waveform = SoftwareWaveform(self._write_volts, lock=self.io_lock,
                                     streams={ch: self.ao[ch] for ch in CHANNELS}, limits=(-10.0, 10.0))

``amplitude`` is the peak deviation from ``offset`` (a sine spans
``offset - amplitude .. offset + amplitude``).
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from .clock import now_ms
from .errors import INVALID_ARGUMENT, DeviceError
from .streams import ScalarStream

log = logging.getLogger("hardwareharness_device_sdk.waveform")

SHAPES = ("sine", "square", "triangle", "sawtooth", "dc")
MAX_SOFTWARE_UPDATE_HZ = 200.0
MAX_START_DELAY_MS = 60_000.0
"""``startAt`` may lie at most this far in the future."""


def waveform_capability(channels: Iterable[int], *, mode: str = "software", shapes: Sequence[str] = SHAPES,
                        max_update_hz: float | None = MAX_SOFTWARE_UPDATE_HZ, max_sample_rate_hz: float | None = None,
                        max_arbitrary_samples: int | None = 4096,
                        timing_accuracy: str = "±5 ms jitter") -> dict[str, Any]:
    """``{"waveform": {...}}`` for ``capability_details()`` (design doc section 5.6.1)."""
    if mode not in {"software", "hardware"}:
        raise ValueError(f"waveform mode must be software or hardware, got {mode!r}")
    unknown = sorted(set(shapes) - set(SHAPES))
    if unknown:
        raise ValueError(f"Unknown waveform shapes {unknown}; supported: {SHAPES}")
    if mode == "software" and (max_update_hz is None or not 0 < max_update_hz <= MAX_SOFTWARE_UPDATE_HZ):
        raise ValueError(f"software waveforms need 0 < max_update_hz <= {MAX_SOFTWARE_UPDATE_HZ}")
    return {"waveform": {"channels": list(channels), "mode": mode, "shapes": list(shapes),
                         "maxUpdateHz": max_update_hz, "maxSampleRateHz": max_sample_rate_hz,
                         "maxArbitrarySamples": max_arbitrary_samples, "timingAccuracy": timing_accuracy}}


def sample_value(shape: str, t_s: float, frequency_hz: float, amplitude: float, offset: float,
                 duty_cycle: float = 0.5, phase_deg: float = 0.0) -> float:
    """Value of ``shape`` at ``t_s`` seconds after the start; all shapes start at ``offset`` rising for phase 0."""
    if shape == "dc":
        return offset
    cycle = (t_s * frequency_hz + phase_deg / 360.0) % 1.0
    if shape == "sine":
        return offset + amplitude * math.sin(2.0 * math.pi * cycle)
    if shape == "square":
        return offset + (amplitude if cycle < duty_cycle else -amplitude)
    if shape == "triangle":
        return offset + amplitude * (1.0 - 4.0 * abs((cycle + 0.25) % 1.0 - 0.5))
    if shape == "sawtooth":
        return offset + amplitude * (2.0 * ((cycle + 0.5) % 1.0) - 1.0)
    raise DeviceError(f"Unknown waveform shape {shape!r}; supported: {SHAPES}", category=INVALID_ARGUMENT)


@dataclass(frozen=True)
class WaveformParams:
    """Effective parameters, returned by ``set_waveform`` as its result data."""

    channel: int
    shape: str
    frequencyHz: float
    amplitude: float
    offset: float
    dutyCycle: float
    phaseDeg: float
    startAt: float
    """Service time (Unix ms) of phase 0."""
    updateHz: float
    """Software write rate actually used."""
    mode: str = "software"

    def public(self) -> dict[str, Any]:
        return asdict(self)


class SoftwareWaveform:
    """Periodic software writes of waveform values to static outputs.

    ``write(channel, value)`` performs one blocking driver write; it is called
    with ``lock`` held (pass the device ``io_lock``). ``streams`` maps channels
    to the setpoint scalar streams that receive every written value.
    ``limits`` bounds every value the waveform can reach.
    """

    def __init__(self, write: Callable[[int, float], Any], *, lock: Any,
                 streams: Mapping[int, ScalarStream] | None = None, channels: Iterable[int] | None = None,
                 max_update_hz: float = MAX_SOFTWARE_UPDATE_HZ, limits: tuple[float, float] | None = None,
                 max_frequency_hz: float | None = None, name: str = "waveform") -> None:
        if not 0 < max_update_hz <= MAX_SOFTWARE_UPDATE_HZ:
            raise ValueError(f"max_update_hz must be in (0, {MAX_SOFTWARE_UPDATE_HZ}]")
        self.write = write
        self.lock = lock
        self.streams = dict(streams or {})
        self.channels = tuple(channels) if channels is not None else tuple(self.streams)
        self.update_hz = float(max_update_hz)
        self.max_frequency_hz = max_frequency_hz if max_frequency_hz is not None else self.update_hz / 2.0
        self.limits = limits
        self.name = name
        self.last_error: dict[str, Any] | None = None
        self._active: dict[int, WaveformParams] = {}
        self._state = threading.Lock()
        self._thread: threading.Thread | None = None
        self._closed = threading.Event()

    # --- control (called from tools, under io_lock) -----------------------
    def set(self, channel: int, shape: str, frequency_hz: float, amplitude: float, offset: float, *,
            duty_cycle: float | None = None, phase_deg: float | None = None,
            start_at: float | None = None) -> dict[str, Any]:
        """Start (or replace) the waveform on ``channel``; returns the effective parameters."""
        if self.channels and channel not in self.channels:
            raise DeviceError(f"Channel {channel} has no waveform output; use one of {list(self.channels)}",
                              category=INVALID_ARGUMENT)
        if shape not in SHAPES:
            raise DeviceError(f"Unknown waveform shape {shape!r}; supported: {SHAPES}", category=INVALID_ARGUMENT)
        values = {"frequencyHz": frequency_hz, "amplitude": amplitude, "offset": offset}
        if not all(math.isfinite(value) for value in values.values()):
            raise DeviceError("frequencyHz, amplitude and offset must be finite", category=INVALID_ARGUMENT)
        if shape == "dc":
            frequency_hz, amplitude = 0.0, 0.0
        elif not 0 < frequency_hz <= self.max_frequency_hz:
            raise DeviceError(f"frequencyHz must be in (0, {self.max_frequency_hz}] for {self.update_hz} Hz software "
                              "updates", category=INVALID_ARGUMENT)
        if amplitude < 0:
            raise DeviceError("amplitude is the peak deviation and must be >= 0", category=INVALID_ARGUMENT)
        duty = 0.5 if duty_cycle is None else duty_cycle
        if not 0 < duty < 1:
            raise DeviceError("dutyCycle must be in (0, 1)", category=INVALID_ARGUMENT)
        if self.limits is not None:
            low, high = self.limits
            if offset - amplitude < low or offset + amplitude > high:
                raise DeviceError(f"offset ± amplitude ({offset - amplitude:g}..{offset + amplitude:g}) leaves "
                                  f"the output range {low:g}..{high:g}", category=INVALID_ARGUMENT)
        now = now_ms()
        start = now if start_at is None else float(start_at)
        if not math.isfinite(start) or start > now + MAX_START_DELAY_MS:
            raise DeviceError(f"startAt must be service time (Unix ms, see /time) at most {MAX_START_DELAY_MS:g} ms "
                              "ahead", category=INVALID_ARGUMENT)
        params = WaveformParams(channel=channel, shape=shape, frequencyHz=float(frequency_hz),
                                amplitude=float(amplitude), offset=float(offset), dutyCycle=float(duty),
                                phaseDeg=float(phase_deg or 0.0) % 360.0, startAt=start, updateHz=self.update_hz)
        with self.lock:
            if start <= now:
                self._write(params, now)  # the first value goes out with the call (tagged with its operation)
            with self._state:
                self._active[channel] = params
                if self._thread is None:
                    self._closed.clear()
                    self._thread = threading.Thread(target=self._run, name=self.name, daemon=True)
                    self._thread.start()
        return params.public()

    def stop(self, channel: int, hold_value: float | None = None) -> dict[str, Any]:
        """Stop ``channel`` and write ``hold_value`` (default: the waveform offset, else 0)."""
        with self.lock:
            with self._state:
                params = self._active.pop(channel, None)
            value = hold_value if hold_value is not None else (params.offset if params is not None else 0.0)
            if self.limits is not None and not self.limits[0] <= value <= self.limits[1]:
                raise DeviceError(f"holdValue {value:g} leaves the output range {self.limits[0]:g}..{self.limits[1]:g}",
                                  category=INVALID_ARGUMENT)
            self.write(channel, value)
            self._publish(channel, value)
        return {"channel": channel, "stopped": params is not None, "holdValue": value}

    def cancel(self, channel: int) -> bool:
        """Stop ``channel`` without writing (a static write to it follows); ``True`` when it was running."""
        with self.lock, self._state:
            return self._active.pop(channel, None) is not None

    def stop_all(self) -> list[int]:
        """Stop every waveform without writing (``safe_state`` writes the safe values next)."""
        with self.lock, self._state:
            stopped = sorted(self._active)
            self._active.clear()
        return stopped

    def running(self) -> dict[int, dict[str, Any]]:
        with self._state:
            return {channel: params.public() for channel, params in self._active.items()}

    def close(self) -> None:
        self.stop_all()
        self._closed.set()
        with self._state:
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(2)

    # --- generator thread ---------------------------------------------
    def _publish(self, channel: int, value: float) -> None:
        stream = self.streams.get(channel)
        if stream is not None:
            stream.publish(value)

    def _write(self, params: WaveformParams, t: float) -> None:
        value = sample_value(params.shape, (t - params.startAt) / 1000.0, params.frequencyHz, params.amplitude,
                             params.offset, params.dutyCycle, params.phaseDeg)
        self.write(params.channel, value)
        self._publish(params.channel, value)

    def _tick(self) -> None:
        with self._state:
            active = list(self._active.values())
        for params in active:
            with self.lock:
                with self._state:
                    if self._active.get(params.channel) is not params:
                        continue  # stopped or replaced meanwhile
                t = now_ms()
                if t < params.startAt:
                    continue
                try:
                    self._write(params, t)
                except Exception as exc:
                    with self._state:
                        if self._active.get(params.channel) is params:
                            del self._active[params.channel]
                    self.last_error = {"channel": params.channel, "message": str(exc), "at": t}
                    log.warning("Waveform on channel %s stopped after a write error: %s", params.channel, exc)

    def _run(self) -> None:
        period = 1.0 / self.update_hz
        next_tick = time.monotonic() + period
        while not self._closed.is_set():
            with self._state:
                if not self._active:
                    self._thread = None
                    return
            delay = next_tick - time.monotonic()
            if delay > 0 and self._closed.wait(delay):
                break
            next_tick += period
            late = time.monotonic() - next_tick
            if late > period:
                next_tick += math.ceil(late / period) * period  # skip missed ticks instead of bursting
            self._tick()
        with self._state:
            if self._thread is threading.current_thread():
                self._thread = None
