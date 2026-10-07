"""Advantech PCI-1762: 16 relays + 16 isolated DI, via hwcli_pci1762.

Streams: ``di`` (bits, sampled, published only on change) and ``relay``
(bits, the coil-control mask published right after every relay write).
"""

from __future__ import annotations

import os
from typing import Any

from teststand_device_sdk import (
    BIT,
    VALUE,
    BitsStream,
    Device,
    DeviceError,
    JsonLineBackend,
    Pinout,
    DeviceConfig,
    control,
    model,
    param,
    tool,
    unwrap,
)

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
    instructions = ("One plugin instance controls exactly one PCI-1762. set_relay/set_bank actuate relays; "
                    "safe_state releases all 16 coils.")
    description = ("Advantech PCI-1762 PCI card with 16 relay outputs (dry contacts R0..R15, OUT/COM pairs) and 16 "
                   "isolated digital inputs (IDI0..IDI15, four ECOM groups) on a 62-pin D-sub (CN1). The relay "
                   "stream is the commanded coil mask, not a contact measurement.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.board_description = str(settings.get("description", os.environ.get("ADVANTECH_PCI1762_DESC",
                                                                                DEFAULT_DESCRIPTION)))
        self.cli: JsonLineBackend = self.select_driver(lambda: hwcli(settings), SimulatedHwcli)
        self.di = self.streams.add(BitsStream("di", sample=lambda: self._read_mask("DI"), publish_on_change=True,
                                              rate_hz=float(settings.get("bitRateHz", 20)),
                                              bit_labels=[f"IDI{bit}" for bit in range(CHANNELS)], kind="measured"))
        self.relay = self.streams.add(BitsStream("relay", bit_labels=[f"R{bit}" for bit in range(CHANNELS)],
                                                 label="Relay coil control", display="switches",
                                                 control=[control("setBit", "set_relay", channel=BIT, closed=VALUE),
                                                          control("setMask", "set_bank", mask=VALUE)]))

    def _request(self, command: dict[str, Any]) -> Any:
        return unwrap(self.cli.call(command))

    # --- lifecycle ----------------------------------------------------
    def open(self) -> Any:
        return self._request({"cmd": "open", "description": self.board_description})

    def close(self) -> Any:
        try:
            return self._request({"cmd": "close"})
        finally:
            self.cli.stop()

    def _read_mask(self, kind: str) -> int:
        return int(self._request({"cmd": "read_mask", "kind": kind})["mask"])

    def _write(self, command: dict[str, Any]) -> Any:
        """Send a relay write, then publish the coil-control readback so the stream shows the effect at once."""
        try:
            return self._request(command)
        finally:
            try:
                self.relay.publish(self._read_mask("RELAY"))
            except DeviceError:
                pass  # the write error (if any) is the one that matters

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=Relay, safety_action="safe_state", effects=("relay_driven",),
          description="Set RELAY0..15; closed=true energizes the coil. Controller feedback does not prove external "
                      "contact continuity or load behavior. Consult pinout for actual OUT/COM wiring and load ratings.")
    def set_relay(self, channel: Channel, closed: Closed) -> Any:
        return self._write({"cmd": "set_relay", "channel": channel, "closed": closed})

    @tool(kind="actuate", output=Mask, safety_action="safe_state", effects=("relay_driven",),
          description="Set all 16 relays from mask bit0=RELAY0. The driver writes separate 8-bit ports, so the whole "
                      "bank is not atomic and a failed write may leave partial changes.")
    def set_bank(self, mask: MaskParam) -> Any:
        return self._write({"cmd": "set_bank", "mask": mask})

    @tool(kind="read", output=Bit, evidence="measurement",
          description="Read channel 0..15 as DI or relay-control feedback. kind=RELAY selects coil control; DO is its "
                      "compatibility alias. This cannot measure contact resistance or prove load isolation.")
    def read_bit(self, channel: Channel, kind: BitKind = "DI") -> Any:
        return self._request({"cmd": "read_bit", "channel": channel, "kind": kind.upper()})

    @tool(kind="safe", output=SafeRelay,
          description="Release all 16 relay coils and check control feedback. This actuates real relays. Failure may "
                      "be partial; all_open describes control state, not a physical continuity measurement.")
    def safe_state(self) -> Any:
        return self._write({"cmd": "safe_state"})

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"channels": {"minimum": 0, "maximum": CHANNELS - 1}, "safeRelayMask": 0, "bankAtomic": False,
                "relayReadbackEvidence": "controller_state", "contactContinuityMeasurement": False}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
