"""Advantech PCI-1762: 16 relays + 16 isolated DI, via hwcli_pci1762."""

from __future__ import annotations

import os
from typing import Any

from hardwareharness_device_sdk import (
    Device,
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
DEFAULT_DESCRIPTION = "PCI-1762,BID#0"

Bit = model("BitResult", channel=(int, "Zero-based channel 0..15."), kind=(str, "DI, DO or RELAY evidence source."),
            value=(bool, "Input level or controller readback; not contact continuity."))
Relay = model("RelayResult", channel=(int, "Relay channel 0..15."), closed=(bool, "Commanded coil state."),
              port=(int, "Driver byte port.", None), bit=(int, "Bit in byte port.", None))
Mask = model("MaskResult", mask=(int, "Commanded 16-bit relay mask."))
SafeRelay = model("SafeRelayResult",
                  relays=(str, "all_open means control state checked; no physical contact measurement."))

Channel = param(int, "Zero-based hardware channel; use the pinout's channelIndex.", ge=0, le=CHANNELS - 1)
Closed = param(bool, "true=relay coil energized; false=released. Not a contact measurement.")
MaskParam = param(int, "16-bit mask, bit0=RELAY0; ports are written sequentially.", ge=0, le=0xFFFF)
BitKind = param(str, "DI=input sample; DO=controller feedback; RELAY=coil control (DO alias).",
                pattern="^(?i:DI|DO|RELAY)$")


class Pci1762(Device):
    manufacturer = "Advantech"
    model = "PCI-1762"
    prefix = "pci1762"
    capabilities = ("relay_output", "digital_input")
    version = "0.2.0"
    instructions = ("One MCP Server controls exactly one PCI-1762. set_relay/set_bank actuate relays; "
                    "safe_state releases all 16 coils.")

    def __init__(self, config: ServerConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.description = str(settings.get("description", os.environ.get("ADVANTECH_PCI1762_DESC",
                                                                          DEFAULT_DESCRIPTION)))
        self.cli: JsonLineBackend = self.select_driver(lambda: hwcli(settings), SimulatedHwcli)
        rate = float(settings.get("bitRateHz", 5))
        schema = {"type": "integer", "minimum": 0, "maximum": 0xFFFF}
        self.streams.add(SampledStream("di", label="IDI0..15", rate_hz=rate, sample=lambda: self._sample_bits("DI"),
                                       value_schema=schema, description="Isolated input bitmap, bit0=IDI0.",
                                       meta={"bits": CHANNELS}))
        self.streams.add(SampledStream("relay", label="RELAY0..15 readback", rate_hz=rate,
                                       sample=lambda: self._sample_bits("RELAY"), value_schema=schema,
                                       description="Coil control readback bitmap, bit0=RELAY0; not contact continuity.",
                                       meta={"bits": CHANNELS}))

    def _request(self, command: dict[str, Any]) -> Any:
        return unwrap(self.cli.call(command))

    # --- lifecycle ----------------------------------------------------
    def open(self) -> Any:
        return self._request({"cmd": "open", "description": self.description})

    def close(self) -> Any:
        try:
            return self._request({"cmd": "close"})
        finally:
            self.cli.stop()

    def _sample_bits(self, kind: str) -> int:
        mask = 0
        for channel in range(CHANNELS):
            if self._request({"cmd": "read_bit", "channel": channel, "kind": kind}).get("value"):
                mask |= 1 << channel
        return mask

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=Relay, safety_action="safe_state", effects=("relay_driven",),
          description="Set RELAY0..15; closed=true energizes the coil. Controller feedback does not prove external "
                      "contact continuity or load behavior. Consult pinout for actual OUT/COM wiring and load ratings.")
    def set_relay(self, channel: Channel, closed: Closed) -> Any:
        return self._request({"cmd": "set_relay", "channel": channel, "closed": closed})

    @tool(kind="actuate", output=Mask, safety_action="safe_state", effects=("relay_driven",),
          description="Set all 16 relays from mask bit0=RELAY0. The driver writes separate 8-bit ports, so the whole "
                      "bank is not atomic and a failed write may leave partial changes.")
    def set_bank(self, mask: MaskParam) -> Any:
        return self._request({"cmd": "set_bank", "mask": mask})

    @tool(kind="read", output=Bit, evidence="measurement",
          description="Read channel 0..15 as DI or relay-control feedback. kind=RELAY selects coil control; DO is its "
                      "compatibility alias. This cannot measure contact resistance or prove load isolation.")
    def read_bit(self, channel: Channel, kind: BitKind = "DI") -> Any:
        return self._request({"cmd": "read_bit", "channel": channel, "kind": kind.upper()})

    @tool(kind="safe", output=SafeRelay,
          description="Release all 16 relay coils and check control feedback. This actuates real relays. Failure may "
                      "be partial; all_open describes control state, not a physical continuity measurement.")
    def safe_state(self) -> Any:
        return self._request({"cmd": "safe_state"})

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"channels": {"minimum": 0, "maximum": CHANNELS - 1}, "safeRelayMask": 0, "bankAtomic": False,
                "relayReadbackEvidence": "controller_state", "contactContinuityMeasurement": False}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)

    def panel(self) -> list[PanelItem]:
        return panel_items.items(self.hardware_id)
