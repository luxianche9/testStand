"""Advantech PCI-1710L: 16 AI + 16 DI + 16 DO (the L model has no AO), via hwcli_pci1710l.

Streams: ``ai0..15`` (scalar, one scan group sharing ``t``; unconfigured
channels report ``not_configured``; ``read_voltage`` results are published
too), ``di`` (bits, sampled, only on change) and ``do`` (bits, controller
readback published right after every output write).
"""

from __future__ import annotations

import os
from typing import Any, Literal

from teststand_device_sdk import (
    BIT,
    NOT_CONFIGURED,
    VALUE,
    BitsStream,
    Device,
    DeviceError,
    JsonLineBackend,
    Pinout,
    ScalarStream,
    control,
    DeviceConfig,
    model,
    param,
    tool,
    unwrap,
)

from .driver import hwcli
from .pinout import pinout as build_pinout
from .sim import SimulatedHwcli

CHANNELS = 16
DEFAULT_DESCRIPTION = "PCI-1710L,BID#15"
VALUE_RANGE_HINT = {1: "±10 V", 2: "±5 V", 3: "±2.5 V", 4: "±1.25 V", 12: "±625 mV",
                    7: "0~10 V", 8: "0~5 V", 9: "0~2.5 V", 10: "0~1.25 V"}

Voltage = model(
    "VoltageResult",
    channel=(int, "Zero-based channel."),
    volts=(float, "Voltage in V; evidence semantics are tool-specific."),
    raw=(int, "Raw ADC code when provided by the driver.", None),
    signal=(str, "AI signal configuration when provided.", None),
    value_range=(int, "AI range enumeration when provided.", None),
)
Bit = model("BitResult", channel=(int, "Zero-based channel 0..15."), kind=(str, "DI, DO or RELAY evidence source."),
            value=(bool, "Input level or controller readback; not contact continuity."))
AiConfig = model("AiConfiguration", channel=(int, "AI channel 0..15."), signal_type=(int, "0=single-ended, 1=differential."),
                 value_range=(int, "Configured range enum."), signal=(str, "Driver signal configuration name.", None))
Level = model("LevelResult", channel=(int, "DO channel 0..15."), level=(bool, "Commanded digital output level."))
SafeDo = model("SafeDoResult", safe_do_mask=(int, "Effective configured 16-bit output safe mask; not necessarily zero."))

Channel = param(int, "Zero-based hardware channel; use the pinout's channelIndex.", ge=0, le=CHANNELS - 1)
SignalType = param(Literal[0, 1], "0=SingleEnded; 1=Differential. Check physical pairing in the /device pinout or manual.")
ValueRange = param(Literal[1, 2, 3, 4, 12, 7, 8, 9, 10],
                   "V ranges: 1=±10, 2=±5, 3=±2.5, 4=±1.25, 12=±0.625, 7=0..10, 8=0..5, 9=0..2.5, 10=0..1.25. "
                   "Driver validates model support.")
BitKind = param(str, "DI=input sample; DO=controller feedback.", pattern="^(?i:DI|DO)$")
LevelParam = param(bool, "true=logic high, false=logic low; real output actuation.")


def configured_safe_mask(settings: Any) -> int:
    raw = settings.get("safeDoMask", os.environ.get("SAFE_DO_MASK", "0"))
    try:
        return (int(raw, 0) if isinstance(raw, str) else int(raw)) & 0xFFFF
    except (TypeError, ValueError):
        return 0


class Pci1710l(Device):
    manufacturer = "Advantech"
    model = "PCI-1710L"
    prefix = "pci1710l"
    capabilities = ("analog_input", "digital_input", "digital_output")
    version = "0.2.0"
    instructions = ("One plugin instance controls exactly one PCI-1710L. configure_ai before read_voltage; "
                    "set_level actuates DO; safe_state applies the configured safe DO mask.")
    description = ("Advantech PCI-1710L multifunction PCI card: 16 single-ended / 8 differential 12-bit analog "
                   "inputs, 16 digital inputs and 16 digital outputs on a 68-pin SCSI connector (CN1). The L model "
                   "has no analog output. AI readings are ADC samples; DO values are controller readback, not a "
                   "measurement at the load.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.board_description = str(settings.get("description", os.environ.get("ADVANTECH_PCI1710L_DESC",
                                                                                DEFAULT_DESCRIPTION)))
        self.startup_safe_mask = configured_safe_mask(settings)
        self.active_safe_mask: int | None = None
        self.cli: JsonLineBackend = self.select_driver(lambda: hwcli(settings), SimulatedHwcli)
        self.ai_config: dict[int, dict[str, Any]] = {}
        self.ai = [self.streams.add(ScalarStream(f"ai{channel}", unit="V", label=f"AI{channel}", kind="measured"))
                   for channel in range(CHANNELS)]
        self.streams.scan(self.ai, self._scan_ai, rate_hz=float(settings.get("aiRateHz", 20)))
        self.di = self.streams.add(BitsStream("di", sample=lambda: self._read_mask("DI"), publish_on_change=True,
                                              rate_hz=float(settings.get("bitRateHz", 20)),
                                              bit_labels=[f"DI{bit}" for bit in range(CHANNELS)], kind="measured"))
        self.do = self.streams.add(BitsStream("do", bit_labels=[f"DO{bit}" for bit in range(CHANNELS)],
                                              label="DO controller readback",
                                              control=[control("setBit", "set_level", channel=BIT, level=VALUE)]))

    def _request(self, command: dict[str, Any]) -> Any:
        return unwrap(self.cli.call(command))

    # --- lifecycle ----------------------------------------------------
    def open(self) -> Any:
        self.ai_config.clear()
        result = self._request({"cmd": "open", "description": self.board_description,
                                "safe_do_mask": self.startup_safe_mask})
        self.active_safe_mask = self.startup_safe_mask
        return result

    def close(self) -> Any:
        try:
            return self._request({"cmd": "close"})
        finally:
            self.active_safe_mask = None
            self.ai_config.clear()
            self.cli.stop()

    # --- sampling -----------------------------------------------------
    def _read_ai(self, channel: int) -> dict[str, Any]:
        result = self._request({"cmd": "read_voltage", "channel": channel})
        self.ai[channel].publish(float(result["volts"]))
        return result

    def _scan_ai(self) -> list[float | None]:
        """One scan over the configured channels; the others yield ``None`` (not_configured)."""
        if not self.ai_config:
            raise DeviceError("No AI channel configured; call configure_ai first", category=NOT_CONFIGURED)
        return [float(self._request({"cmd": "read_voltage", "channel": channel})["volts"])
                if channel in self.ai_config else None for channel in range(CHANNELS)]

    def _read_mask(self, kind: str) -> int:
        return int(self._request({"cmd": "read_mask", "kind": kind})["mask"])

    def _write(self, command: dict[str, Any]) -> Any:
        """Send a DO write, then publish the controller readback so the stream shows the effect at once."""
        try:
            return self._request(command)
        finally:
            try:
                self.do.publish(self._read_mask("DO"))
            except DeviceError:
                pass  # the write error (if any) is the one that matters

    # --- tools --------------------------------------------------------
    @tool(kind="configure", output=AiConfig, effects=("analog_input_configured",),
          description="Configure one zero-based AI channel before voltage reads. signal_type=0 single-ended or 1 "
                      "differential; range enums are in the parameter. Differential pairing and reference ground must "
                      "match the manual; unsupported hardware settings are rejected by the driver.")
    def configure_ai(self, channel: Channel, signal_type: SignalType = 0, value_range: ValueRange = 1) -> Any:
        result = self._request({"cmd": "configure_ai", "channel": channel, "signal_type": signal_type,
                                "value_range": value_range})
        self.ai_config[channel] = {"signal_type": signal_type, "value_range": value_range}
        return result

    @tool(kind="read", output=Voltage, requires=("analog_input_configured",), evidence="measurement",
          description="Measure one configured AI channel in V. Configure its signal type and range first; a numeric "
                      "reading alone does not identify the connected source, validate ground wiring or prove the DUT "
                      "behavior.")
    def read_voltage(self, channel: Channel) -> Any:
        return self._read_ai(channel)

    @tool(kind="read", output=Bit, evidence="measurement",
          description="Read DI or DO-controller feedback on channel 0..15. DI is an electrical input sample; DO is "
                      "output-control readback and does not prove voltage at the remote load.")
    def read_bit(self, channel: Channel, kind: BitKind = "DI") -> Any:
        return self._request({"cmd": "read_bit", "channel": channel, "kind": kind.upper()})

    @tool(kind="actuate", output=Level, safety_action="safe_state", effects=("do_driven",),
          description="Drive one DO channel 0..15 to the requested logic level. This changes real electrical outputs; "
                      "successful driver acceptance is not a measurement of the load.")
    def set_level(self, channel: Channel, level: LevelParam) -> Any:
        return self._write({"cmd": "set_level", "channel": channel, "level": level})

    @tool(kind="safe", output=SafeDo,
          description="Apply the configured safe_do_mask to all 16 digital outputs. The mask can be nonzero; "
                      "get_hardware_info publishes its effective value. Failure may leave a partial state; do not "
                      "assume outputs are de-energized.")
    def safe_state(self) -> Any:
        return self._write({"cmd": "safe_state"})

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        is_open = self.active_safe_mask is not None
        return {
            "channels": {"minimum": 0, "maximum": CHANNELS - 1},
            "signalTypes": {"0": "SingleEnded", "1": "Differential"},
            "voltageRanges": {str(key): value for key, value in VALUE_RANGE_HINT.items()},
            "effectiveSafeDoMask": self.active_safe_mask if is_open else self.startup_safe_mask,
            "safeValueSource": "open_session" if is_open else "startup_configuration",
            "voltageEvidence": "adc_sample",
            "doEvidence": "controller_readback",
            "configuredAiChannels": sorted(self.ai_config),
        }

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
