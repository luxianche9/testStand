"""Advantech PCI-1710L: 16 AI + 16 DI + 16 DO (the L model has no AO), via hwcli_pci1710l."""

from __future__ import annotations

import os
from typing import Any, Literal

from hardwareharness_device_sdk import (
    NOT_CONFIGURED,
    Device,
    DeviceError,
    JsonLineBackend,
    PanelItem,
    Pinout,
    SampledStream,
    ServerConfig,
    model,
    param,
    tool,
    unwrap,
)

from . import panel as panel_items
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
SignalType = param(Literal[0, 1], "0=SingleEnded; 1=Differential. Check physical pairing in get_pinout/manual.")
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
    instructions = ("One MCP Server controls exactly one PCI-1710L. configure_ai before read_voltage; "
                    "set_level actuates DO; safe_state applies the configured safe DO mask.")

    def __init__(self, config: ServerConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.description = str(settings.get("description", os.environ.get("ADVANTECH_PCI1710L_DESC",
                                                                          DEFAULT_DESCRIPTION)))
        self.startup_safe_mask = configured_safe_mask(settings)
        self.active_safe_mask: int | None = None
        self.cli: JsonLineBackend = self.select_driver(lambda: hwcli(settings), SimulatedHwcli)
        self.ai_config: dict[int, dict[str, Any]] = {}
        rate = float(settings.get("aiRateHz", 10))
        for channel in range(CHANNELS):
            self.streams.add(SampledStream(
                f"ai{channel}", label=f"AI{channel}", unit="V", channel=channel, rate_hz=rate,
                sample=lambda channel=channel: self._sample_ai(channel), requires=("analog_input_configured",),
                value_schema={"type": "number"}, description="ADC sample in V; configure_ai first.",
                capacity=4096))
        bits = float(settings.get("bitRateHz", 5))
        self.streams.add(SampledStream("di", label="DI0..15", rate_hz=bits, sample=lambda: self._sample_bits("DI"),
                                       value_schema={"type": "integer", "minimum": 0, "maximum": 0xFFFF},
                                       description="Input bitmap, bit0=DI0.", meta={"bits": CHANNELS}))
        self.streams.add(SampledStream("do", label="DO0..15 readback", rate_hz=bits,
                                       sample=lambda: self._sample_bits("DO"),
                                       value_schema={"type": "integer", "minimum": 0, "maximum": 0xFFFF},
                                       description="DO controller readback bitmap, bit0=DO0; not load voltage.",
                                       meta={"bits": CHANNELS}))

    def _request(self, command: dict[str, Any]) -> Any:
        return unwrap(self.cli.call(command))

    # --- lifecycle ----------------------------------------------------
    def open(self) -> Any:
        self.ai_config.clear()
        result = self._request({"cmd": "open", "description": self.description,
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
    def _sample_ai(self, channel: int) -> float:
        if channel not in self.ai_config:
            raise DeviceError(f"AI{channel} is not configured; call configure_ai first", category=NOT_CONFIGURED)
        return float(self._request({"cmd": "read_voltage", "channel": channel})["volts"])

    def _sample_bits(self, kind: str) -> int:
        mask = 0
        for channel in range(CHANNELS):
            if self._request({"cmd": "read_bit", "channel": channel, "kind": kind}).get("value"):
                mask |= 1 << channel
        return mask

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
        return self._request({"cmd": "read_voltage", "channel": channel})

    @tool(kind="read", output=Bit, evidence="measurement",
          description="Read DI or DO-controller feedback on channel 0..15. DI is an electrical input sample; DO is "
                      "output-control readback and does not prove voltage at the remote load.")
    def read_bit(self, channel: Channel, kind: BitKind = "DI") -> Any:
        return self._request({"cmd": "read_bit", "channel": channel, "kind": kind.upper()})

    @tool(kind="actuate", output=Level, safety_action="safe_state", effects=("do_driven",),
          description="Drive one DO channel 0..15 to the requested logic level. This changes real electrical outputs; "
                      "successful driver acceptance is not a measurement of the load.")
    def set_level(self, channel: Channel, level: LevelParam) -> Any:
        return self._request({"cmd": "set_level", "channel": channel, "level": level})

    @tool(kind="safe", output=SafeDo,
          description="Apply the configured safe_do_mask to all 16 digital outputs. The mask can be nonzero; "
                      "get_hardware_info publishes its effective value. Failure may leave a partial state; do not "
                      "assume outputs are de-energized.")
    def safe_state(self) -> Any:
        return self._request({"cmd": "safe_state"})

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

    def panel(self) -> list[PanelItem]:
        return panel_items.items(self.hardware_id)
