"""ADLINK PCI-6208V: 8-channel ±10 V analog output, no output readback.

The board has no ADC on its outputs, so the ``ao{n}`` streams and
``read_last`` report the software shadow of accepted writes, never a
measured voltage.
"""

from __future__ import annotations

import math
import os
from typing import Any

from hardwareharness_device_sdk import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
    INVALID_ARGUMENT,
    Device,
    DeviceError,
    PanelItem,
    Pinout,
    ServerConfig,
    Stream,
    model,
    param,
    tool,
)

from . import panel as panel_items
from .driver import DaskDriver
from .pinout import pinout as build_pinout
from .sim import SimulatedDask

CHANNEL_COUNT = 8
VOLT_MIN = -10.0
VOLT_MAX = 10.0

Voltage = model(
    "VoltageResult",
    channel=(int, "Zero-based channel."),
    volts=(float, "Voltage in V; evidence semantics are tool-specific."),
    raw=(int, "Raw ADC code when provided by the driver.", None),
    signal=(str, "AI signal configuration when provided.", None),
    value_range=(int, "AI range enumeration when provided.", None),
)
SafeAo = model("SafeAoResult", safe_volts=(float, "Effective configured safe output in V applied to all 8 channels."))

Channel = param(int, "Zero-based hardware channel; use the pinout's channelIndex.", ge=0, le=CHANNEL_COUNT - 1)
Volts = param(float, "Finite commanded output in V. Outside [-10,10] is rejected, never clamped.",
              ge=VOLT_MIN, le=VOLT_MAX, allow_inf_nan=False)


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
    version = "0.2.0"

    def __init__(self, config: ServerConfig) -> None:
        super().__init__(config)
        self.card_index = configured_card_index(config.settings)
        self.startup_safe_volts = configured_safe_volts(config.settings)
        self.safe_volts = self.startup_safe_volts
        self.driver = self.select_driver(lambda: DaskDriver(config.settings.get("dllPath")), SimulatedDask)
        self.handle: int | None = None
        self.last_volts: list[float | None] = [None] * CHANNEL_COUNT
        self.ao = [
            self.streams.add(Stream(f"ao{channel}", label=f"AO{channel}", unit="V", channel=channel, capacity=1024,
                                    value_schema={"type": "number"},
                                    description="Software shadow of accepted writes; not a measured voltage."))
            for channel in range(CHANNEL_COUNT)
        ]

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
        self.ao[channel].publish(volts, source="software_shadow")

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
        rc = self.driver.write(handle, channel, value)
        if rc != 0:
            raise DeviceError(f"AO_VWriteChannel failed rc={rc}", details={"rc": rc})
        self._record(channel, value)
        return {"channel": channel, "volts": value}

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
        return {
            "channels": {"minimum": 0, "maximum": CHANNEL_COUNT - 1},
            "voltageRange": {"minimum": VOLT_MIN, "maximum": VOLT_MAX, "unit": "V"},
            "effectiveSafeVolts": self.safe_volts if is_open else self.startup_safe_volts,
            "safeValueSource": "open_session" if is_open else "startup_configuration",
            "readLastEvidence": "software_shadow",
            "outputAdcReadback": False,
        }

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)

    def panel(self) -> list[PanelItem]:
        return panel_items.items(self.hardware_id, self.safe_volts)
