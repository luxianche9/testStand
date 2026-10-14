"""Devices-JC JCXD-MADS-CPCI-3210(-1S/-2S): 32 AI, 8 AO, 48 TTL DIO, 2 counters on two Mini SCSI-68.

Product manual (JCXD-MADS-X-3210/-XS) and software manual V1.0.0:

* AI: 32 single-ended / 16 differential, 16 bit, ±10 V (-1S ±30 V, -2S ±60 V: the driver's ±10 V
  reading times 3 or 6), up to 500 kS/s shared over the scan list. Acquisition is hardware-clocked
  and continuous from ``open``: a drain thread empties the driver buffer every ``DRAIN_S`` and the
  ``ai<n>`` block streams carry every sample at the card rate. Each word carries its channel number
  (bits 29..24); frames whose channel order does not match the scan list are counted and dropped.
* AO: 8 single-ended, ±10 V, 16 bit, 10 mA per channel / 80 mA total; static or the card's own
  waveform generator (sine/square/triangle/sawtooth, 1 Hz-20 kHz). No output readback.
* DIO: 48 TTL lines, direction per line; output state reads back from the register.
* CT: 2 counters (frequency measurement, pulse count, PWM output 0.1 Hz-4 MHz).
"""

from __future__ import annotations

import logging
import math
import statistics
import threading
import time
from collections import deque
from typing import Any, Literal

from teststand_device_sdk import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
    INVALID_ARGUMENT,
    NOT_CONFIGURED,
    BitsStream,
    BlockStream,
    Check,
    Claim,
    Device,
    DeviceConfig,
    DeviceError,
    Pinout,
    ScalarStream,
    check_equal,
    check_range,
    claim_resource,
    model,
    param,
    tool,
)
from teststand_device_sdk.clock import now_ms
from teststand_device_sdk.streams import Sampler

from .driver import MAX_CARDS, Mads3210Driver
from .pinout import pinout as build_pinout
from .sim import SimulatedMads3210

log = logging.getLogger(__name__)

CARD_TYPE = 0x3210
AI_COUNT, AO_COUNT, DIO_COUNT, CT_COUNT = 32, 8, 48, 2
INPUT_RANGES = (10.0, 30.0, 60.0)
MAX_AGGREGATE_HZ = 500_000.0
DRAIN_S = 0.02
WINDOW_S = 2.0
STREAM_HZ = 20.0
WAVE_SHAPES = {"sine": 0, "square": 1, "triangle": 2, "sawtooth": 3}

AiStats = model("MadsAiStats", channel=(int, "AI channel."), mean=(float, "Mean in V."), min=(float, "Minimum in V."),
                max=(float, "Maximum in V."), std=(float, "Population standard deviation in V."),
                n=(int, "Samples in the window."))
AiRead = model("MadsAiRead", channels=(list[AiStats], "Statistics per channel over the window."),
               durationMs=(float, "Window length actually covered, ms."),
               rateHz=(float, "Configured per-channel sample rate."))
AiConfig = model("MadsAiConfig", channels=(list[int], "Scan list."), mode=(str, "single or differential."),
                 rateHz=(float, "Per-channel sample rate."), aggregateHz=(float, "Words per second over the scan."))
AoResult = model("MadsAo", channel=(int, "AO channel."), volts=(float, "Accepted setting in V; not measured."))
WaveResult = model("MadsWave", channel=(int, "AO channel."), shape=(str, "Waveform."),
                   amplitude=(float, "Peak amplitude V."), frequencyHz=(float, "Hz."), offset=(float, "Offset V."),
                   phaseDeg=(float, "Phase, degrees."))
DioState = model("MadsDio", inputs=(int, "Bit i = level of input line i (lines configured as input)."),
                 outputs=(int, "Bit i = register state of output line i (lines configured as output)."),
                 outputMask=(int, "Bit i set = line i is an output."))
DoResult = model("MadsDo", channel=(int, "DIO line."), level=(int, "Register state read back after the write."))
CtFrequency = model("MadsFreq", channel=(int, "Counter."), frequencyHz=(float, "Latest measured frequency, Hz."),
                    readings=(int, "Readings returned by the driver in this call."))
CtCount = model("MadsCount", channel=(int, "Counter."), count=(int, "Pulses counted since start_count."))
CtState = model("MadsCt", channel=(int, "Counter."), mode=(str, "frequency, count, pwm or idle."),
                frequencyHz=(float, "PWM frequency, Hz.", None), dutyPct=(float, "PWM duty, %.", None))
SafeResult = model("MadsSafe", aoVolts=(float, "Value written to all AO."), doLevel=(int, "Level written to outputs."),
                   failed=(list[str], "Steps that failed."))

AiChannel = param(int, "AI channel 0..31 (single-ended) or 0..15 (differential).", ge=0, le=AI_COUNT - 1)
AoChannel = param(int, "AO channel 0..7 (VOUT0..VOUT7).", ge=0, le=AO_COUNT - 1)
DioLine = param(int, "DIO line 0..47.", ge=0, le=DIO_COUNT - 1)
CtChannel = param(int, "Counter 0..1.", ge=0, le=CT_COUNT - 1)
AoVolts = param(float, "Voltage in V, -10..10.", ge=-10, le=10, allow_inf_nan=False)


def parse_channels(value: Any, limit: int) -> list[int]:
    """``"0-7,10"`` or a list -> sorted unique channel list within ``0..limit-1``."""
    if isinstance(value, str):
        items: list[int] = []
        for part in value.replace(" ", "").split(","):
            if not part:
                continue
            low, _, high = part.partition("-")
            items.extend(range(int(low), int(high or low) + 1))
    else:
        items = [int(item) for item in value]
    channels = sorted(set(items))
    if not channels or channels[0] < 0 or channels[-1] >= limit:
        raise ValueError(f"channels must be within 0..{limit - 1}, got {value!r}")
    return channels


class Acquisition:
    """Continuous AI state: scan list, per-channel pending blocks for streams, rolling window for reads."""

    def __init__(self, channels: list[int], mode: int, rate_hz: float) -> None:
        self.channels, self.mode, self.rate_hz = channels, mode, rate_hz
        self.dt_ms = 1000.0 / rate_hz
        self.frames = 0
        self.misaligned = 0
        self.saturated: set[int] = set()
        self.t_start: float | None = None
        self.pending: dict[int, list[float]] = {channel: [] for channel in channels}
        self.pending_start = 0
        self.window: deque[tuple[int, list[list[float]]]] = deque()

    def interrupt_depth(self) -> int:
        """Words per driver interrupt: about one drain period of data, so latency stays near DRAIN_S."""
        return max(1, min(8100, int(self.rate_hz * len(self.channels) * DRAIN_S)))


class JcxdMads3210(Device):
    manufacturer = "Devices-JC"
    model = "JCXD-MADS-CPCI-3210"
    prefix = "mads"
    capabilities = ("analog_input", "analog_output", "digital_input", "digital_output", "counter")
    isolation = "subprocess"
    version = "1.0.2"
    instructions = ("JCXD-MADS-CPCI-3210: AI is sampled continuously by the card (ai<n> streams, read_ai for "
                    "statistics over a window); AO, DIO and counters by their tools. DIO lines are inputs until "
                    "configure_dio makes them outputs.")
    description = ("Devices-JC JCXD-MADS-CPCI-3210 (-1S/-2S), 3U CPCI multifunction card on two Mini SCSI-68 "
                   "connectors: 32 single-ended/16 differential 16-bit AI (±10/±30/±60 V by model, hardware-clocked "
                   "continuous acquisition up to 500 kS/s aggregate), 8 static/waveform AO ±10 V, 48 TTL DIO with "
                   "output register readback, 2 32-bit counters (frequency, pulse count, PWM).")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.range_v = float(settings.get("inputRangeV", 10.0))
        if self.range_v not in INPUT_RANGES:
            raise ValueError(f"inputRangeV must be one of {INPUT_RANGES}, got {self.range_v}")
        self.scale = self.range_v / 10.0
        serial = settings.get("serialNumber")
        self.serial = int(serial) if serial not in (None, "") else None
        self.card_index = int(settings.get("cardIndex", 0))
        self.ai_default = (parse_channels(settings.get("aiChannels", f"0-{AI_COUNT - 1}"), AI_COUNT),
                           1 if settings.get("aiMode", "single") == "differential" else 0,
                           float(settings.get("aiRateHz", 1000.0)))
        self.do_default = parse_channels(settings["doChannels"], DIO_COUNT) if settings.get("doChannels") else []
        self.safe_ao = float(settings.get("safeVolts", 0.0))
        self.safe_do = int(settings.get("doSafeLevel", 0))
        if abs(self.safe_ao) > 10 or self.safe_do not in (0, 1):
            raise ValueError("safeVolts must be within ±10 V and doSafeLevel 0 or 1")
        self.driver = self.select_driver(lambda: Mads3210Driver(settings.get("dllPath")), SimulatedMads3210)
        self.handle: int | None = None
        self.identity: dict[str, int] = {}
        self.lut: list[float] = []
        self.acq: Acquisition | None = None
        self.outputs: set[int] = set()
        self.do_shadow: dict[int, int] = {}
        self.ao_last: list[float | None] = [None] * AO_COUNT
        self.waves: dict[int, dict[str, Any]] = {}
        self.ct_mode: dict[int, dict[str, Any]] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.claim: Claim | None = None

        self.ai = [BlockStream(f"ai{n}", unit="V", label=f"AI{n}", kind="measured") for n in range(AI_COUNT)]
        for stream in self.ai:
            self.streams.add(stream)
        Sampler(self.ai, self._sample_ai, rate_hz=STREAM_HZ)
        self.ao = [self.streams.add(ScalarStream(f"ao{n}", unit="V", label=f"AO{n}", kind="setpoint"))
                   for n in range(AO_COUNT)]
        labels = [f"DIO{n}" for n in range(DIO_COUNT)]
        self.di = self.streams.add(BitsStream("di", sample=self._sample_di, rate_hz=50.0, width=DIO_COUNT,
                                              bit_labels=labels, label="DIO input levels", kind="measured",
                                              publish_on_change=True))
        self.do = self.streams.add(BitsStream("do", width=DIO_COUNT, bit_labels=labels, label="DIO output registers",
                                              kind="measured"))
        self.freq = [self.streams.add(ScalarStream(f"freq{n}", unit="Hz", label=f"CT{n} frequency", kind="measured",
                                                   sample=lambda n=n: self._sample_freq(n), rate_hz=5.0))
                     for n in range(CT_COUNT)]

    # --- lifecycle ----------------------------------------------------
    def _claim(self, card_id: int) -> Claim | None:
        """This process's exclusive hold on the card (none for the simulator). Another device
        instance bound to the same card would reset it and split its AI data with this one."""
        if self.dry_run:
            return None
        return claim_resource(f"jcxd_mads3210/card{card_id}",
                              owner=f"{self.config.device_id} ({self.config.hardware_id})")

    def _release_claim(self) -> None:
        if self.claim is not None:
            self.claim.release()
            self.claim = None

    def _open_card(self) -> tuple[int, dict[str, int]]:
        ids = range(MAX_CARDS) if self.serial is not None else (self.card_index,)
        seen: list[Any] = []
        busy: list[str] = []
        for card_id in ids:
            # Claim before opening: opening and resetting a card another instance runs disturbs it.
            try:
                claim = self._claim(card_id)
            except DeviceError as error:
                busy.append(str(error))
                continue
            rc, handle = self.driver.open(card_id)
            if rc != 0 or handle is None:
                if claim is not None:
                    claim.release()
                continue
            info_rc, info = self.driver.info(handle)
            if info_rc == 0 and info.get("cardType") == 0:
                # A process that died mid-acquisition leaves the identity registers reading 0
                # until the card is reset (observed on this card); reset and read again.
                self.driver.reset(handle)
                info_rc, info = self.driver.info(handle)
            if self.serial is None or info.get("serialNumber") == self.serial:
                self.claim = claim
                return handle, {**info, "cardId": card_id, "infoRc": info_rc}
            seen.append(info.get("serialNumber"))
            self.driver.close(handle)
            if claim is not None:
                claim.release()
        wanted = f"serial number {self.serial}" if self.serial is not None else f"card id {self.card_index}"
        if busy and not seen:
            raise DeviceError(f"JCXD-MADS-CPCI-3210 with {wanted} is already used by another device instance: "
                              f"{'; '.join(busy)}. Remove the duplicate device, or give each instance its card's "
                              "serialNumber.", category=DEVICE_UNREACHABLE, details={"busy": busy})
        raise DeviceError(f"JCXD-MADS-CPCI-3210 with {wanted} not found (cards seen: {seen})",
                          category=DEVICE_UNREACHABLE, details={"seen": seen, "busy": busy})

    def open(self) -> dict[str, Any]:
        handle, identity = self._open_card()
        if self.driver.reset(handle) != 0:
            self.driver.close(handle)
            self._release_claim()
            raise DeviceError("UMADX3210_ResetDev failed", category=DEVICE_UNREACHABLE)
        self.handle, self.identity = handle, identity
        self.lut = [self.driver.convert(code) * self.scale for code in range(1 << 16)]
        self.outputs, self.do_shadow, self.waves, self.ct_mode = set(), {}, {}, {}
        self.ao_last = [None] * AO_COUNT
        failed = [n for n in range(DIO_COUNT) if self.driver.di_create(handle, n) != 0]
        failed += [n for n in range(AO_COUNT) if self.driver.da_create(handle, n) != 0]
        if self.do_default:
            self._configure_outputs(self.do_default)
        self._start_ai(*self.ai_default)
        self._stop.clear()
        self._thread = threading.Thread(target=self._drain_loop, name="mads-ai-drain", daemon=True)
        self._thread.start()
        return {"identity": identity, "createFailed": failed, "ai": self._ai_config()}

    def close(self) -> dict[str, Any]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
        handle, self.handle = self.handle, None
        if handle is not None:
            self.driver.ad_stop(handle)
            self.driver.reset(handle)
            self.driver.close(handle)
        self._release_claim()
        self.acq = None
        return {"closed": handle is not None}

    def _require(self) -> int:
        if self.handle is None:
            raise DeviceError("Card not open.", category=DEVICE_UNREACHABLE)
        return self.handle

    @staticmethod
    def _check(rc: int, what: str, **details: Any) -> None:
        if rc != 0:
            raise DeviceError(f"{what} failed rc={rc}", category=DEVICE_ERROR, details={"rc": rc, **details})

    # --- analog input -------------------------------------------------
    def _start_ai(self, channels: list[int], mode: int, rate_hz: float) -> None:
        handle = self._require()
        limit = AI_COUNT // 2 if mode else AI_COUNT
        if channels[-1] >= limit:
            raise DeviceError(f"differential AI channels are 0..{limit - 1}", category=INVALID_ARGUMENT)
        aggregate = rate_hz * len(channels)
        if not 1 <= rate_hz or aggregate > MAX_AGGREGATE_HZ:
            raise DeviceError(f"rate {rate_hz} Hz × {len(channels)} channels = {aggregate} S/s; the card shares "
                              f"{MAX_AGGREGATE_HZ:.0f} S/s over the scan list", category=INVALID_ARGUMENT)
        self.driver.ad_stop(handle)
        acq = Acquisition(channels, mode, rate_hz)
        self._check(self.driver.ad_create(handle, channels, mode), "AD_CreateChan", channels=channels)
        self._check(self.driver.ad_configure(handle, aggregate, acq.interrupt_depth()), "AD_CfgSampParam")
        self._check(self.driver.ad_start(handle), "AD_StartEx")
        self.acq = acq

    def _drain_loop(self) -> None:
        while not self._stop.wait(DRAIN_S):
            try:
                with self.io_lock:
                    self._drain()
            except Exception:
                log.exception("AI drain failed")
                self._stop.wait(1.0)

    def _drain(self) -> None:
        """Move whole frames from the driver into the pending blocks and the rolling window (under io_lock)."""
        acq, handle = self.acq, self.handle
        if acq is None or handle is None:
            return
        frame = len(acq.channels)
        rc, words = self.driver.ad_read(handle, frame)
        self._check(rc, "AD_Read")
        if not words:
            return
        now = now_ms()
        count = len(words) // frame
        if acq.t_start is None:
            acq.t_start = now - count * acq.dt_ms
        columns: list[list[float]] = [[] for _ in acq.channels]
        lut, full = self.lut, 0.995 * self.range_v
        for index in range(count):
            row = words[index * frame:(index + 1) * frame]
            if any((word >> 24) & 0x3F != channel for word, channel in zip(row, acq.channels, strict=True)):
                acq.misaligned += 1
                continue
            for slot, word in enumerate(row):
                value = lut[word & 0xFFFF]
                if abs(value) >= full:
                    acq.saturated.add(acq.channels[slot])
                columns[slot].append(value)
        if not columns[0]:
            return
        first = acq.frames
        acq.frames += len(columns[0])
        expected_end = acq.t_start + acq.frames * acq.dt_ms
        if abs(expected_end - now) > 500:
            log.info("AI clock re-anchored by %.0f ms", now - expected_end)
            acq.t_start = now - acq.frames * acq.dt_ms
        keep = int(WINDOW_S * acq.rate_hz)
        for channel, column in zip(acq.channels, columns, strict=True):
            pending = acq.pending[channel]
            pending.extend(column)
            if len(pending) > keep:
                del pending[:len(pending) - keep]
        acq.pending_start = acq.frames - len(acq.pending[acq.channels[0]])
        acq.window.append((first, columns))
        while acq.window and acq.window[0][0] + len(acq.window[0][1][0]) < acq.frames - keep:
            acq.window.popleft()

    def _sample_ai(self) -> list[Any]:
        self._drain()
        acq = self.acq
        if acq is None:
            raise DeviceError("AI not running", category=NOT_CONFIGURED)
        if acq.t_start is None:
            return [None] * AI_COUNT
        t0 = acq.t_start + acq.pending_start * acq.dt_ms
        values: list[Any] = []
        for n in range(AI_COUNT):
            pending = acq.pending.get(n)
            if pending is None:
                values.append(None)
            elif pending:
                values.append((list(pending), acq.dt_ms, t0))
                pending.clear()
            else:
                values.append(None)
        acq.pending_start = acq.frames
        return values

    def _ai_config(self) -> dict[str, Any]:
        acq = self.acq
        if acq is None:
            return {}
        return {"channels": acq.channels, "mode": "differential" if acq.mode else "single", "rateHz": acq.rate_hz,
                "aggregateHz": acq.rate_hz * len(acq.channels)}

    @tool(kind="configure", output=AiConfig,
          description="Restart continuous AI with a new scan list, input mode and per-channel rate. The card shares "
                      "500 kS/s over the scan list (rate × channels ≤ 500000). Differential pairs AIn+/AI(n+16)-, "
                      "n = 0..15. Streams of channels outside the scan list report not_configured.")
    def configure_ai(self, channels: param(list[int], "AI channels to scan, e.g. [0,1,2]; unique, 1..32 entries.",
                                           min_length=1, max_length=AI_COUNT),
                     rate_hz: param(float, "Per-channel sample rate, Hz.", ge=1, le=MAX_AGGREGATE_HZ) = 1000.0,
                     mode: param(Literal["single", "differential"], "Input mode.") = "single") -> dict[str, Any]:
        try:
            scan = parse_channels(channels, AI_COUNT)
        except ValueError as exc:
            raise DeviceError(str(exc), category=INVALID_ARGUMENT) from exc
        self._start_ai(scan, 1 if mode == "differential" else 0, rate_hz)
        return self._ai_config()

    def _collect(self, channels: list[int], duration_ms: float) -> tuple[dict[int, list[float]], float]:
        """Drain until ``duration_ms`` of new frames arrived; return them per channel."""
        acq = self.acq
        if acq is None:
            raise DeviceError("AI not running", category=NOT_CONFIGURED)
        missing = [channel for channel in channels if channel not in acq.channels]
        if missing:
            raise DeviceError(f"AI channels {missing} are not in the scan list {acq.channels}; use configure_ai",
                              category=INVALID_ARGUMENT)
        self._drain()
        start = acq.frames
        need = max(1, math.ceil(duration_ms / acq.dt_ms))
        deadline = time.monotonic() + duration_ms / 1000 + 2.0
        while acq.frames - start < need:
            if time.monotonic() > deadline:
                raise DeviceError(f"AI delivered {acq.frames - start} of {need} frames", category=DEVICE_ERROR)
            time.sleep(DRAIN_S / 2)
            self._drain()
        slots = {channel: acq.channels.index(channel) for channel in channels}
        out: dict[int, list[float]] = {channel: [] for channel in channels}
        for first, columns in acq.window:
            lo = max(0, start - first)
            if lo >= len(columns[0]):
                continue
            for channel, slot in slots.items():
                out[channel].extend(columns[slot][lo:])
        return out, (acq.frames - start) * acq.dt_ms

    @tool(kind="read", output=AiRead, evidence="measurement",
          description="Measure AI channels over a window of new samples (default 100 ms) from the running "
                      "acquisition: mean, min, max, standard deviation in V per channel.")
    def read_ai(self, channels: param(list[int], "AI channels in the scan list.", min_length=1, max_length=AI_COUNT),
                duration_ms: param(float, "Window length in ms.", ge=1, le=10_000) = 100.0) -> dict[str, Any]:
        data, covered = self._collect(sorted(set(channels)), duration_ms)
        stats = [{"channel": channel, "mean": statistics.fmean(values), "min": min(values), "max": max(values),
                  "std": statistics.pstdev(values), "n": len(values)} for channel, values in data.items()]
        assert self.acq is not None
        return {"channels": stats, "durationMs": covered, "rateHz": self.acq.rate_hz}

    # --- analog output ------------------------------------------------
    def _write_ao(self, handle: int, channel: int, volts: float) -> int:
        if channel in self.waves:
            self.driver.da_stop_wave(handle, channel)
            self.waves.pop(channel)
            rc = self.driver.da_create(handle, channel)
            if rc != 0:
                return rc
        rc = self.driver.da_write(handle, channel, volts)
        if rc == 0:
            self.ao_last[channel] = volts
            self.ao[channel].publish(volts)
        return rc

    @tool(kind="actuate", output=AoResult, safety_action="safe_state", effects=("ao_driven",),
          description="Set one AO channel to a static voltage (-10..10 V); stops a running waveform on that channel "
                      "first. The result is the accepted setting; the card has no output readback. Load ≤10 mA.")
    def write_ao(self, channel: AoChannel, volts: AoVolts) -> dict[str, Any]:
        self._check(self._write_ao(self._require(), channel, volts), "DA_WriteVoltage", channel=channel)
        return {"channel": channel, "volts": volts}

    @tool(kind="actuate", output=WaveResult, safety_action="safe_state", effects=("ao_driven",),
          description="Start the card's waveform generator on one AO channel: sine, square, triangle or sawtooth, "
                      "1-20000 Hz, peak amplitude plus |offset| ≤ 10 V. Hardware-timed; stop with stop_wave, "
                      "write_ao or safe_state.")
    def start_wave(self, channel: AoChannel,
                   shape: param(Literal["sine", "square", "triangle", "sawtooth"], "Waveform shape."),
                   amplitude: param(float, "Peak amplitude, V.", ge=0, le=10, allow_inf_nan=False),
                   frequency_hz: param(float, "Frequency, Hz.", ge=1, le=20_000, allow_inf_nan=False),
                   offset: param(float, "Offset, V.", ge=-10, le=10, allow_inf_nan=False) = 0.0,
                   phase_deg: param(float, "Phase, degrees (sine and square).", ge=0, le=360) = 0.0
                   ) -> dict[str, Any]:
        if amplitude + abs(offset) > 10:
            raise DeviceError("amplitude + |offset| must not exceed 10 V", category=INVALID_ARGUMENT)
        handle = self._require()
        if channel in self.waves:
            self.driver.da_stop_wave(handle, channel)
        self._check(self.driver.da_wave(handle, channel, WAVE_SHAPES[shape], amplitude, frequency_hz, phase_deg,
                                        offset), "DA_CreateWaveChan/StartWave", channel=channel)
        wave = {"channel": channel, "shape": shape, "amplitude": amplitude, "frequencyHz": frequency_hz,
                "offset": offset, "phaseDeg": phase_deg}
        self.waves[channel] = wave
        self.ao_last[channel] = None
        return wave

    @tool(kind="actuate", output=AoResult, safety_action="safe_state", effects=("ao_driven",),
          description="Stop the waveform on one AO channel and hold a static voltage (default 0 V). The result is the "
                      "accepted setting, not a measured output voltage.")
    def stop_wave(self, channel: AoChannel, hold_volts: AoVolts = 0.0) -> dict[str, Any]:
        handle = self._require()
        if channel not in self.waves:
            raise DeviceError(f"AO{channel} has no running waveform", category=INVALID_ARGUMENT)
        self._check(self._write_ao(handle, channel, hold_volts), "DA_WriteVoltage", channel=channel)
        return {"channel": channel, "volts": hold_volts}

    # --- digital I/O --------------------------------------------------
    def _configure_outputs(self, lines: list[int]) -> None:
        handle = self._require()
        for line in range(DIO_COUNT):
            if line in lines and line not in self.outputs:
                self._check(self.driver.do_create(handle, line), "IO_CreateDOChan", line=line)
                self._check(self.driver.do_write(handle, line, self.safe_do), "IO_WriteDOChan", line=line)
                self.outputs.add(line)
                self.do_shadow[line] = self.safe_do
            elif line not in lines and line in self.outputs:
                self._check(self.driver.di_create(handle, line), "IO_CreateDIChan", line=line)
                self.outputs.discard(line)
                self.do_shadow.pop(line, None)
        self._publish_do()

    def _register_mask(self) -> int:
        handle = self._require()
        mask = 0
        for line in sorted(self.outputs):
            rc, level = self.driver.do_status(handle, line)
            self._check(rc, "IO_GetDOChanStatus", line=line)
            mask |= level << line
        return mask

    def _publish_do(self) -> int:
        mask = self._register_mask()
        self.do.publish(mask)
        return mask

    def _input_mask(self) -> int:
        handle = self._require()
        mask = 0
        for line in range(DIO_COUNT):
            if line in self.outputs:
                continue
            rc, level = self.driver.di_read(handle, line)
            self._check(rc, "IO_ReadDIChan", line=line)
            mask |= level << line
        return mask

    def _sample_di(self) -> int | None:
        return self._input_mask() if self.handle is not None else None

    def _dio_state(self) -> dict[str, Any]:
        mask = 0
        for line in self.outputs:
            mask |= 1 << line
        return {"inputs": self._input_mask(), "outputs": self._register_mask(), "outputMask": mask}

    @tool(kind="configure", output=DioState, safety_action="safe_state", effects=("dio_direction",),
          description="Make the listed DIO lines outputs (driven to doSafeLevel at once) and every other line an "
                      "input. Inputs are pulled up on the card by default (JP1-JP6), so an open input reads 1.")
    def configure_dio(self, outputs: param(list[int], "DIO lines 0..47 to drive; [] makes all lines inputs.",
                                           max_length=DIO_COUNT)) -> dict[str, Any]:
        try:
            lines = parse_channels(outputs, DIO_COUNT) if outputs else []
        except ValueError as exc:
            raise DeviceError(str(exc), category=INVALID_ARGUMENT) from exc
        self._configure_outputs(lines)
        return self._dio_state()

    @tool(kind="actuate", output=DoResult, safety_action="safe_state", effects=("do_driven",),
          description="Drive one DIO output line low (0) or high (1) and read the register back. The line must be "
                      "an output (configure_dio).")
    def write_do(self, line: DioLine, level: param(int, "0 = low, 1 = high.", ge=0, le=1)) -> dict[str, Any]:
        handle = self._require()
        if line not in self.outputs:
            raise DeviceError(f"DIO{line} is an input; configure_dio first", category=INVALID_ARGUMENT)
        self._check(self.driver.do_write(handle, line, level), "IO_WriteDOChan", line=line)
        self.do_shadow[line] = level
        rc, back = self.driver.do_status(handle, line)
        self._check(rc, "IO_GetDOChanStatus", line=line)
        self._publish_do()
        if back != level:
            raise DeviceError(f"DIO{line} register reads {back} after writing {level}", category=DEVICE_ERROR,
                              details={"line": line, "written": level, "readBack": back})
        return {"channel": line, "level": back}

    @tool(kind="read", output=DioState, evidence="controller_state",
          description="Read all DIO lines: input levels, output register states and which lines are outputs.")
    def read_dio(self) -> dict[str, Any]:
        return self._dio_state()

    # --- counters -----------------------------------------------------
    def _stop_counter(self, handle: int, channel: int) -> None:
        if channel in self.ct_mode:
            self.driver.ct_stop(handle, channel)
            self.ct_mode.pop(channel)

    @tool(kind="configure", output=CtState,
          description="Put a counter in frequency-measurement mode on Pulse_In_n (TTL). Read with read_frequency "
                      "or the freq<n> stream.")
    def start_frequency(self, channel: CtChannel) -> dict[str, Any]:
        handle = self._require()
        self._stop_counter(handle, channel)
        self._check(self.driver.ct_frequency(handle, channel), "CT_CreateFreqChan/Start", channel=channel)
        self.ct_mode[channel] = {"mode": "frequency", "last": None}
        return {"channel": channel, "mode": "frequency"}

    def _read_frequency(self, channel: int) -> tuple[float | None, int]:
        handle = self._require()
        rc, values = self.driver.ct_read_frequency(handle, channel)
        self._check(rc, "CT_ReadFreq", channel=channel)
        state = self.ct_mode[channel]
        if values:
            state["last"] = values[-1]
        return state["last"], len(values)

    def _sample_freq(self, channel: int) -> float | None:
        if self.handle is None or self.ct_mode.get(channel, {}).get("mode") != "frequency":
            return None
        value, _ = self._read_frequency(channel)
        return value

    @tool(kind="read", output=CtFrequency, evidence="measurement",
          description="Latest frequency measured by a counter in frequency mode on Pulse_In_n, in Hz: a measurement by the card. "
                      "Fails when no edge has arrived yet.")
    def read_frequency(self, channel: CtChannel) -> dict[str, Any]:
        if self.ct_mode.get(channel, {}).get("mode") != "frequency":
            raise DeviceError(f"CT{channel} is not measuring frequency; start_frequency first",
                              category=NOT_CONFIGURED)
        value, count = self._read_frequency(channel)
        if value is None:
            raise DeviceError(f"CT{channel}: no frequency reading yet (no signal on Pulse_In_{channel}?)",
                              category=DEVICE_ERROR)
        return {"channel": channel, "frequencyHz": value, "readings": count}

    @tool(kind="configure", output=CtState,
          description="Put a counter in pulse-count mode: it counts edges on Pulse_In_n (TTL) from zero until stopped or "
                      "reconfigured. Drives nothing.")
    def start_count(self, channel: CtChannel) -> dict[str, Any]:
        handle = self._require()
        self._stop_counter(handle, channel)
        self._check(self.driver.ct_count(handle, channel), "CT_CreatePulseCntChan/Start", channel=channel)
        self.ct_mode[channel] = {"mode": "count"}
        return {"channel": channel, "mode": "count"}

    @tool(kind="read", output=CtCount, evidence="measurement",
          description="Pulses counted on Pulse_In_n since start_count, read from the counter register: a "
                      "measurement. Fails when the counter is not in count mode.")
    def read_count(self, channel: CtChannel) -> dict[str, Any]:
        if self.ct_mode.get(channel, {}).get("mode") != "count":
            raise DeviceError(f"CT{channel} is not counting; start_count first", category=NOT_CONFIGURED)
        rc, count = self.driver.ct_read_count(self._require(), channel)
        self._check(rc, "CT_ReadPulseCnt", channel=channel)
        return {"channel": channel, "count": count}

    @tool(kind="actuate", output=CtState, safety_action="safe_state", effects=("pwm_driven",),
          description="Output PWM on PWM_Out_n: 0.1 Hz-4 MHz, duty 0-100 %. Updates a running PWM in place.")
    def start_pwm(self, channel: CtChannel,
                  frequency_hz: param(float, "Frequency, Hz.", ge=0.1, le=4_000_000, allow_inf_nan=False),
                  duty_pct: param(float, "Duty cycle, %.", ge=0, le=100, allow_inf_nan=False)) -> dict[str, Any]:
        handle = self._require()
        if self.ct_mode.get(channel, {}).get("mode") == "pwm":
            self._check(self.driver.ct_pwm_update(handle, channel, frequency_hz, duty_pct), "CT_WritePulseOut")
        else:
            self._stop_counter(handle, channel)
            self._check(self.driver.ct_pwm(handle, channel, frequency_hz, duty_pct), "CT_CreatePulseOutChan/Start")
        self.ct_mode[channel] = {"mode": "pwm", "frequencyHz": frequency_hz, "dutyPct": duty_pct}
        return {"channel": channel, "mode": "pwm", "frequencyHz": frequency_hz, "dutyPct": duty_pct}

    @tool(kind="actuate", output=CtState, safety_action="safe_state",
          description="Stop a counter in any mode (PWM output, frequency or count). A stopped PWM output stops toggling; the "
                      "result is the accepted state.")
    def stop_counter(self, channel: CtChannel) -> dict[str, Any]:
        self._stop_counter(self._require(), channel)
        return {"channel": channel, "mode": "idle"}

    # --- safety -------------------------------------------------------
    @tool(kind="safe", output=SafeResult,
          description="Stop PWM and waveforms, write safeVolts (default 0 V) to all AO and doSafeLevel (default 0) "
                      "to every DIO output. AI acquisition keeps running.")
    def safe_state(self) -> dict[str, Any]:
        handle = self._require()
        failed: list[str] = []
        for channel in list(self.ct_mode):
            if self.ct_mode[channel]["mode"] == "pwm":
                if self.driver.ct_stop(handle, channel) != 0:
                    failed.append(f"CT{channel}")
                self.ct_mode.pop(channel)
        for channel in range(AO_COUNT):
            if self._write_ao(handle, channel, self.safe_ao) != 0:
                failed.append(f"AO{channel}")
        for line in sorted(self.outputs):
            if self.driver.do_write(handle, line, self.safe_do) != 0:
                failed.append(f"DIO{line}")
            else:
                self.do_shadow[line] = self.safe_do
        self._publish_do()
        if failed:
            raise DeviceError(f"safe_state incomplete: {failed}", details={"failed": failed})
        return {"aoVolts": self.safe_ao, "doLevel": self.safe_do, "failed": failed}

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        identity, acq = self.identity, self.acq
        serial = identity.get("serialNumber")
        checks = [
            check_equal("读板卡信息", identity.get("infoRc"), 0, "UMADX3210_Get_DevParInfo 返回码"),
            check_equal("板卡类型", f"{identity.get('cardType', 0):#x}", f"{CARD_TYPE:#x}", "dwCardType"),
            check_equal("AI 通道数（板卡报告）", identity.get("channelMax"), AI_COUNT, "dwChMax"),
            Check("序列号", bool(serial) and (self.serial is None or serial == self.serial), serial,
                  self.serial if self.serial is not None else "非零", f"cardId {identity.get('cardId')}"),
        ]
        if acq is None:
            return [*checks, Check("AI 连续采集", False, "未运行", "运行中")]
        self._drain()
        frames0, misaligned0, t0 = acq.frames, acq.misaligned, time.monotonic()
        acq.saturated.clear()
        while time.monotonic() - t0 < 1.0:
            time.sleep(DRAIN_S / 2)
            self._drain()
        elapsed = time.monotonic() - t0
        achieved = (acq.frames - frames0) / elapsed
        try:
            data, _ = self._collect(acq.channels, 100.0)
            worst: float | None = max(abs(value) for values in data.values() for value in values)
        except DeviceError:
            worst = None
        checks += [
            check_range("AI 实际采样率", round(achieved, 1), 0.95 * acq.rate_hz, 1.05 * acq.rate_hz, "Hz",
                        f"{len(acq.channels)} 通道硬件时钟连续采集，1 s 内实收帧数；配置 {acq.rate_hz} Hz/通道"),
            check_equal("AI 帧对齐", acq.misaligned - misaligned0, 0,
                        "每个采样字的通道号（bit29..24）与扫描表一致；不一致的帧被丢弃并计数"),
            Check("AI 读数在量程内", worst is not None and not acq.saturated, worst and round(worst, 4), f"< {0.995 * self.range_v} V",
                  f"量程 ±{self.range_v} V；饱和通道 {sorted(acq.saturated)}" if acq.saturated else
                  f"量程 ±{self.range_v} V（inputRangeV 须与型号一致：标准 10，-1S 30，-2S 60）"),
        ]
        try:
            self._input_mask()
            checks.append(Check("DIO 输入读取", True, f"{DIO_COUNT - len(self.outputs)} 路", "全部成功"))
        except DeviceError as exc:
            checks.append(Check("DIO 输入读取", False, str(exc), "全部成功"))
        registers = {line: self.driver.do_status(self._require(), line)[1] for line in sorted(self.outputs)}
        checks.append(check_equal("DO 寄存器回读", registers, {line: self.do_shadow[line] for line in registers},
                                  "IO_GetDOChanStatus 与最后写入一致" if registers else "没有配置为输出的 DIO 线"))
        return checks

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"ai": {"channels": AI_COUNT, "rangeV": self.range_v, "maxAggregateHz": MAX_AGGREGATE_HZ,
                       "running": self._ai_config()},
                "ao": {"channels": AO_COUNT, "rangeV": 10.0, "outputReadback": False, "safeVolts": self.safe_ao,
                       "waveform": {"shapes": list(WAVE_SHAPES), "frequencyHz": [1, 20000]}},
                "dio": {"lines": DIO_COUNT, "outputs": sorted(self.outputs), "safeLevel": self.safe_do,
                        "outputReadback": True},
                "counter": {"channels": CT_COUNT, "modes": ["frequency", "count", "pwm"]},
                "card": {"serialNumber": self.serial, "cardIndex": self.card_index}}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
