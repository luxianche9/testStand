"""ADLINK PCI-6208V: 8-channel ±10 V analog output, no output readback.

The board has no ADC on its outputs, so the ``ao{n}`` scalar streams
(``kind="setpoint"``) and ``read_last`` report the software shadow of accepted
writes (published on write), never a measured voltage.

The card has no FIFO or hardware clock, so ``set_waveform`` runs the SDK
software generator (DEC-06): a server thread writes at most
``WAVEFORM_UPDATE_HZ`` values per second under ``io_lock``. Every written
value is published to the channel's setpoint stream; judge the physical
output with an independent measurement (e.g. a PCI-1710L AI channel).
"""

from __future__ import annotations

import math
import os
from typing import Any, Literal

from hardwareharness_device_sdk import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
    INVALID_ARGUMENT,
    Device,
    DeviceError,
    Pinout,
    ServerConfig,
    ScalarStream,
    SoftwareWaveform,
    model,
    param,
    tool,
    waveform_capability,
)

from .driver import DaskDriver
from .pinout import pinout as build_pinout
from .sim import SimulatedDask

CHANNEL_COUNT = 8
VOLT_MIN = -10.0
VOLT_MAX = 10.0
WAVEFORM_UPDATE_HZ = 200.0
"""Software write rate; AO_VWriteChannel is a single-value static write."""
WAVEFORM_MAX_HZ = 20.0
"""Highest waveform frequency: at least 10 written points per period at ``WAVEFORM_UPDATE_HZ``."""

Voltage = model(
    "VoltageResult",
    channel=(int, "Zero-based channel."),
    volts=(float, "Voltage in V; evidence semantics are tool-specific."),
    raw=(int, "Raw ADC code when provided by the driver.", None),
    signal=(str, "AI signal configuration when provided.", None),
    value_range=(int, "AI range enumeration when provided.", None),
)
Waveform = model(
    "WaveformResult",
    channel=(int, "Zero-based channel."),
    shape=(str, "Waveform shape."),
    frequencyHz=(float, "Effective frequency in Hz (0 for dc)."),
    amplitude=(float, "Peak deviation from offset in V (0 for dc)."),
    offset=(float, "Center value in V."),
    dutyCycle=(float, "Square-wave high fraction."),
    phaseDeg=(float, "Start phase in degrees."),
    startAt=(float, "Service time (Unix ms, the clock of stream record t) of phase 0."),
    updateHz=(float, "Software write rate actually used."),
    mode=(str, "Always software on this card."),
)
WaveformStop = model(
    "WaveformStopResult",
    channel=(int, "Zero-based channel."),
    stopped=(bool, "Whether a waveform was running on the channel."),
    holdValue=(float, "Static voltage written after stopping, in V."),
)
SafeAo = model("SafeAoResult", safe_volts=(float, "Effective configured safe output in V applied to all 8 channels."))

Channel = param(int, "Zero-based hardware channel; use the pinout's channelIndex.", ge=0, le=CHANNEL_COUNT - 1)
Volts = param(float, "Finite commanded output in V. Outside [-10,10] is rejected, never clamped.",
              ge=VOLT_MIN, le=VOLT_MAX, allow_inf_nan=False)
Shape = param(Literal["sine", "square", "triangle", "sawtooth", "dc"],
              "Waveform shape; all shapes start at offset (rising) for phaseDeg 0.")
FrequencyHz = param(float, f"Frequency in Hz, > 0 and <= {WAVEFORM_MAX_HZ:g} (ignored for dc).", ge=0,
                    le=WAVEFORM_MAX_HZ, allow_inf_nan=False)
Amplitude = param(float, "Peak deviation from offset in V; offset ± amplitude must stay within [-10,10].", ge=0,
                  le=VOLT_MAX - VOLT_MIN, allow_inf_nan=False)
Offset = param(float, "Center value in V within [-10,10].", ge=VOLT_MIN, le=VOLT_MAX, allow_inf_nan=False)
DutyCycle = param(float | None, "Square-wave high fraction in (0,1); default 0.5.", gt=0, lt=1)
PhaseDeg = param(float | None, "Start phase in degrees; default 0.", ge=-360, le=360)
StartAt = param(float | None, "Service time (Unix ms, the clock of stream record t) of phase 0 for synchronized starts; at most "
                "60 s ahead; default now.")
HoldValue = param(float | None, "Static voltage to hold after stopping; default the waveform offset (0 V when "
                  "none ran).", ge=VOLT_MIN, le=VOLT_MAX, allow_inf_nan=False)


def clamp_volts(volts: float) -> float:
    """Clamp a configured safe value into range; nonfinite values are a configuration error."""
    if not math.isfinite(volts):
        raise ValueError("safe_volts must be finite")
    return min(max(volts, VOLT_MIN), VOLT_MAX)


def configured_safe_volts(settings: Any) -> float:
    raw = settings.get("safeVolts", os.environ.get("ADLINK_SAFE_VOLTS", "0.0"))
    try:
        return clamp_volts(float(raw))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"safeVolts/ADLINK_SAFE_VOLTS must be a finite number, got {raw!r}") from exc


def configured_card_index(settings: Any) -> int:
    index = int(settings.get("cardIndex", os.environ.get("ADLINK_CARD_INDEX", "0")))
    if index < 0:
        raise ValueError("cardIndex/ADLINK_CARD_INDEX must be >= 0")
    return index


class Pci6208v(Device):
    manufacturer = "ADLINK"
    model = "PCI-6208V"
    prefix = "pci6208v"
    capabilities = ("analog_output",)
    isolation = "subprocess"  # PCIS-DASK writes to stdout when the DLL loads
    version = "0.2.0"
    description = ("ADLINK PCI-6208V PCI card with eight ±10 V static analog outputs on a 37-pin D-sub (CN1). "
                   "It has no output readback: the ao0..ao7 streams are setpoint shadows, never measurements. "
                   "Low-frequency waveforms are generated in software (at most 200 writes/s per card).")

    def __init__(self, config: ServerConfig) -> None:
        super().__init__(config)
        self.card_index = configured_card_index(config.settings)
        self.startup_safe_volts = configured_safe_volts(config.settings)
        self.safe_volts = self.startup_safe_volts
        self.driver = self.select_driver(lambda: DaskDriver(config.settings.get("dllPath")), SimulatedDask)
        self.handle: int | None = None
        self.last_volts: list[float | None] = [None] * CHANNEL_COUNT
        self.ao = [
            self.streams.add(ScalarStream(f"ao{channel}", capacity=1024, unit="V", label=f"AO{channel}",
                                          kind="setpoint"))
            for channel in range(CHANNEL_COUNT)
        ]
        self.waveform = SoftwareWaveform(self._waveform_write, lock=self.io_lock,
                                         streams=dict(enumerate(self.ao)), max_update_hz=WAVEFORM_UPDATE_HZ,
                                         limits=(VOLT_MIN, VOLT_MAX), max_frequency_hz=WAVEFORM_MAX_HZ,
                                         name="pci6208v-waveform")

    # --- lifecycle ----------------------------------------------------
    def open(self) -> dict[str, Any]:
        rc = self.driver.register(self.card_index)
        if rc < 0:
            raise DeviceError(f"Register_Card(PCI_6208V, {self.card_index}) failed with {rc}",
                              category=DEVICE_UNREACHABLE, details={"result": rc})
        self.handle = rc
        self.safe_volts = self.startup_safe_volts
        self.last_volts = [None] * CHANNEL_COUNT
        return {"card_index": self.card_index, "handle": rc, "safe_volts": self.safe_volts}

    def close(self) -> dict[str, Any]:
        self.waveform.stop_all()
        handle, self.handle = self.handle, None
        self.last_volts = [None] * CHANNEL_COUNT
        if handle is not None:
            rc = self.driver.release(handle)
            if rc != 0:
                raise DeviceError(f"Release_Card failed rc={rc}", details={"rc": rc, "handle": handle})
        return {"released_handle": handle}

    def _require_open(self) -> int:
        if self.handle is None:
            raise DeviceError("Card not open.", category=DEVICE_UNREACHABLE)
        return self.handle

    def _record(self, channel: int, volts: float) -> None:
        self.last_volts[channel] = volts
        self.ao[channel].publish(volts)

    def _waveform_write(self, channel: int, volts: float) -> None:
        """One generator write (the waveform publishes the setpoint itself)."""
        rc = self.driver.write(self._require_open(), channel, volts)
        if rc != 0:
            raise DeviceError(f"AO_VWriteChannel failed rc={rc}", details={"rc": rc, "channel": channel})
        self.last_volts[channel] = volts

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=Voltage, safety_action="safe_state", effects=("ao_driven",), evidence="observation",
          description="Drive AO0..7 in V within [-10,10]; nonfinite or out-of-range requests are rejected before the "
                      "driver call. Result is the accepted setting, not a measured output voltage; respect "
                      "connected-load limits.")
    def set_voltage(self, channel: Channel, volts: Volts) -> dict[str, Any]:
        # Schema validation already rejects these; keep the driver call unreachable for direct callers too.
        if not 0 <= channel < CHANNEL_COUNT:
            raise DeviceError(f"channel must be 0..{CHANNEL_COUNT - 1}, got {channel}", category=INVALID_ARGUMENT)
        if not math.isfinite(volts) or not VOLT_MIN <= volts <= VOLT_MAX:
            raise DeviceError(f"volts {volts} outside [{VOLT_MIN}, {VOLT_MAX}] V; refused, never clamped",
                              category=INVALID_ARGUMENT)
        handle = self._require_open()
        value = float(volts)
        self.waveform.cancel(channel)  # a static write replaces a running waveform
        rc = self.driver.write(handle, channel, value)
        if rc != 0:
            raise DeviceError(f"AO_VWriteChannel failed rc={rc}", details={"rc": rc})
        self._record(channel, value)
        return {"channel": channel, "volts": value}

    @tool(kind="actuate", output=Waveform, safety_action="safe_state", effects=("ao_driven", "waveform_running"),
          evidence="observation",
          description="Start (or replace) a software-generated waveform on AO0..7: sine, square, triangle, sawtooth or "
                      "dc, at most 20 Hz, written at up to 200 values/s with ±5 ms jitter. offset ± amplitude must "
                      "stay within [-10,10] V. Returns the effective parameters; written values appear on the aoN "
                      "setpoint stream, which is not a measurement. safe_state stops every waveform.")
    def set_waveform(self, channel: Channel, shape: Shape, frequencyHz: FrequencyHz, amplitude: Amplitude,  # noqa: N803
                     offset: Offset, dutyCycle: DutyCycle = None, phaseDeg: PhaseDeg = None,  # noqa: N803
                     startAt: StartAt = None) -> dict[str, Any]:  # noqa: N803
        self._require_open()
        return self.waveform.set(channel, shape, frequencyHz, amplitude, offset, duty_cycle=dutyCycle,
                                 phase_deg=phaseDeg, start_at=startAt)

    @tool(kind="actuate", output=WaveformStop, safety_action="safe_state", effects=("ao_driven",),
          evidence="observation",
          description="Stop the waveform on AO0..7 and hold a static voltage: holdValue, else the waveform offset, "
                      "else 0 V. Also valid when no waveform runs (then it is a static write of holdValue or 0 V).")
    def stop_waveform(self, channel: Channel, holdValue: HoldValue = None) -> dict[str, Any]:  # noqa: N803
        self._require_open()
        return self.waveform.stop(channel, holdValue)

    @tool(kind="read", output=Voltage, evidence="software_shadow",
          description="Read the software shadow of the last accepted write during this open session. This board has "
                      "no ADC output readback; never treat this value as measured voltage. Fails when the channel "
                      "has no recorded write.")
    def read_last(self, channel: Channel) -> dict[str, Any]:
        self._require_open()
        value = self.last_volts[channel]
        if value is None:
            raise DeviceError(f"AO{channel} never written this session. Manual says power-on is 0 V, but that is "
                              "inference not measurement — refusing to invent a reading.",
                              category=DEVICE_ERROR, details={"channel": channel, "last_volts": None})
        return {"channel": channel, "volts": value}

    @tool(kind="safe", output=SafeAo,
          description="Drive all eight analog outputs to effective safe_volts from get_hardware_info. That configured "
                      "voltage is not necessarily 0 V. Output is software/driver evidence; failure details identify "
                      "channels that may remain unsafe.")
    def safe_state(self) -> dict[str, Any]:
        self.waveform.stop_all()  # before the static writes, so no generator write can follow them
        handle = self._require_open()
        failures = []
        for channel in range(CHANNEL_COUNT):
            rc = self.driver.write(handle, channel, self.safe_volts)
            if rc != 0:
                failures.append({"channel": channel, "rc": rc})
            else:
                self._record(channel, self.safe_volts)
        if failures:
            raise DeviceError(f"safe_state incomplete: {len(failures)} channel(s) failed",
                              details={"failures": failures, "safe_volts": self.safe_volts})
        return {"safe_volts": self.safe_volts}

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        is_open = self.handle is not None
        waveform = waveform_capability(range(CHANNEL_COUNT), max_update_hz=WAVEFORM_UPDATE_HZ,
                                       max_arbitrary_samples=None,
                                       timing_accuracy="±5 ms jitter (software timer; Windows scheduling)")
        waveform["waveform"]["maxFrequencyHz"] = WAVEFORM_MAX_HZ
        return {
            "channels": {"minimum": 0, "maximum": CHANNEL_COUNT - 1},
            "voltageRange": {"minimum": VOLT_MIN, "maximum": VOLT_MAX, "unit": "V"},
            "effectiveSafeVolts": self.safe_volts if is_open else self.startup_safe_volts,
            "safeValueSource": "open_session" if is_open else "startup_configuration",
            "readLastEvidence": "software_shadow",
            "outputAdcReadback": False,
            **waveform,
        }

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
