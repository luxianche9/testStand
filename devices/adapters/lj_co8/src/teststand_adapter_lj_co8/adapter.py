"""Sinoder LJ-CO-CPCI-8 (PCI id 2016:4281, "PXI-4281"): 8 programmable capacitors, 5..1000 pF.

User manual V1.0: 8 channels, 5 pF to 1000 pF, 1 pF resolution, ±0.5 pF accuracy, 0.5 W maximum,
capacitor-plus-relay arrays calibrated at the factory (calibration stored on the card and applied
by the driver), DB-37 male connector. The vendor driver PXI4281.dll is 32-bit only, so the card is
driven through the 32-bit bridge hwcli_lj_co8.exe (see driver.py).

The card has no readback of the capacitance: the c{n} streams (``kind="setpoint"``) and
``read_last`` are the software shadow of values the driver accepted, never a measured capacitance.
Measure it with an LCR meter (README.md, acceptance). The vendor calibration writes (SetBias,
SaveBias, SetSN, WriteReg) are deliberately not exposed.
"""

from __future__ import annotations

import math
from typing import Any

from teststand_device_sdk import (
    DEVICE_UNREACHABLE,
    INVALID_ARGUMENT,
    Check,
    Device,
    DeviceConfig,
    DeviceError,
    JsonLineBackend,
    Pinout,
    ScalarStream,
    check_equal,
    model,
    param,
    tool,
    unwrap,
)

from .driver import hwcli
from .pinout import in_pin, out_pin
from .pinout import pinout as build_pinout
from .sim import SimulatedHwcli

CHANNELS = 8
MIN_PF, MAX_PF = 5.0, 1000.0
DEFAULT_PF = 1000.0
"""PXI4281_DEF_CAP in PXI4281_api.h; the vendor demo shows it on every channel after connecting."""

Capacitance = model("Co8Capacitance", channel=(int, "Capacitor channel 0..7."),
                    pf=(float, "Accepted setting in pF; not a measured capacitance."))
Capacitances = model("Co8Capacitances", pf=(list[float], "Accepted setting of channels 0..7, in pF."))
SafeResult = model("Co8Safe", safePf=(float, "Value written to all 8 channels, in pF."))

Channel = param(int, "Capacitor channel 0..7 (Chn In / Chn Out on the DB-37).", ge=0, le=CHANNELS - 1)
Picofarads = param(float, "Capacitance in pF, 5..1000 (1 pF resolution, ±0.5 pF).", ge=MIN_PF, le=MAX_PF,
                   allow_inf_nan=False)


def check_pf(name: str, value: float) -> float:
    if not math.isfinite(value) or not MIN_PF <= value <= MAX_PF:
        raise ValueError(f"{name} must lie within {MIN_PF:g}..{MAX_PF:g} pF, got {value}")
    return float(value)


class LjCo8(Device):
    manufacturer = "Sinoder"
    model = "LJ-CO-CPCI-8"
    prefix = "co8"
    capabilities = ("capacitance_simulation",)
    version = "1.0.0"
    instructions = ("LJ-CO-CPCI-8: 8 programmable capacitors C0..C7, 5..1000 pF each, between Chn In and Chn Out "
                    "on the DB-37. set_capacitance sets one channel, set_all sets all eight; nothing is read back.")
    description = ("Sinoder LJ-CO-CPCI-8 (PXI-4281), 3U CPCI/PCI, 8 independent programmable capacitors from relay-"
                   "switched capacitor arrays: 5 pF to 1000 pF, 1 pF resolution, ±0.5 pF accuracy (factory "
                   "calibrated), 0.5 W maximum, DB-37 male. Channel n sits between Chn In (pin 20+2n) and Chn Out "
                   "(pin 3+2n). No readback: the c streams are setpoint shadows. Card selected by serialNumber "
                   "or VISA resource.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.safe_pf = check_pf("safePf", float(settings.get("safePf", DEFAULT_PF)))
        serial = settings.get("serialNumber")
        self.serial = int(serial) if serial not in (None, "") else None
        self.resource_setting = str(settings.get("resource") or "")
        self.dll_path = str(settings.get("dllPath") or "")
        self.cli: JsonLineBackend = self.select_driver(lambda: hwcli(settings), SimulatedHwcli)
        self.identity: dict[str, Any] = {}
        self.last: list[float | None] = [None] * CHANNELS
        self.c = [self.streams.add(ScalarStream(f"c{n}", unit="pF", label=f"C{n}", kind="setpoint"))
                  for n in range(CHANNELS)]

    def _request(self, command: dict[str, Any]) -> Any:
        return unwrap(self.cli.call(command))

    # --- lifecycle ----------------------------------------------------
    def _candidates(self) -> list[str]:
        if self.resource_setting or self.serial is None:
            return [self.resource_setting]  # "" lets the bridge take the first card VISA finds
        listed = self._request({"cmd": "enumerate", "dll": self.dll_path})
        return [str(card["resource"]) for card in listed]

    def open(self) -> dict[str, Any]:
        seen = []
        for resource in self._candidates():
            opened = self._request({"cmd": "open", "resource": resource, "dll": self.dll_path})
            if self.serial is None or opened.get("serialNumber") == self.serial:
                self.identity = self._request({"cmd": "identity"})
                self.last = [None] * CHANNELS
                return {"identity": self.identity}
            seen.append({"resource": opened.get("resource"), "serialNumber": opened.get("serialNumber")})
            self._request({"cmd": "close"})
        raise DeviceError(f"LJ-CO-CPCI-8 with serial number {self.serial} not found (cards seen: {seen})",
                          category=DEVICE_UNREACHABLE, details={"seen": seen})

    def close(self) -> Any:
        try:
            return self._request({"cmd": "close"})
        finally:
            self.cli.stop()

    def _accepted(self, values: dict[int, float]) -> None:
        for channel, pf in values.items():
            self.last[channel] = pf
            self.c[channel].publish(pf)

    def _set_all(self, values: list[float]) -> list[float]:
        self._request({"cmd": "set_all", **{f"pf{n}": value for n, value in enumerate(values)}})
        self._accepted(dict(enumerate(values)))
        return values

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=Capacitance, safety_action="safe_state", effects=("capacitance_switched",),
          evidence="observation",
          description="Set one channel's capacitance between Chn In and Chn Out, 5..1000 pF. Out-of-range values are "
                      "refused before the driver call. Switching relays briefly changes the capacitance while it "
                      "settles. The result is the accepted setting, not a measured capacitance.")
    def set_capacitance(self, channel: Channel, pf: Picofarads) -> dict[str, Any]:
        value = self._check(pf)
        self._request({"cmd": "set_cap", "channel": channel, "pf": value})
        self._accepted({channel: value})
        return {"channel": channel, "pf": value}

    @tool(kind="actuate", output=Capacitances, safety_action="safe_state", effects=("capacitance_switched",),
          evidence="observation",
          description="Set all 8 channels to the same capacitance (5..1000 pF) in one driver call. On failure the "
                      "channels may hold old or new values; set them again or measure before relying on them.")
    def set_all(self, pf: Picofarads) -> dict[str, Any]:
        value = self._check(pf)
        return {"pf": self._set_all([value] * CHANNELS)}

    @tool(kind="read", output=Capacitance, evidence="software_shadow",
          description="The last capacitance accepted on one channel in this session (software shadow). The card has "
                      "no readback; this is never a measured capacitance.")
    def read_last(self, channel: Channel) -> dict[str, Any]:
        value = self.last[channel]
        if value is None:
            raise DeviceError(f"C{channel} not set in this session", category=INVALID_ARGUMENT)
        return {"channel": channel, "pf": value}

    @tool(kind="safe", output=SafeResult,
          description="Set all 8 channels to safePf (default 1000 pF, the driver's default value). A passive "
                      "capacitor has no 'off' state; on failure the channels may hold old values.")
    def safe_state(self) -> dict[str, Any]:
        self._set_all([self.safe_pf] * CHANNELS)
        return {"safePf": self.safe_pf}

    def _check(self, pf: float) -> float:
        if not math.isfinite(pf) or not MIN_PF <= pf <= MAX_PF:
            raise DeviceError(f"pf {pf} outside {MIN_PF:g}..{MAX_PF:g} pF; refused, never clamped",
                              category=INVALID_ARGUMENT)
        return float(pf)

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        result = self._request({"cmd": "self_test"})
        identity = self.identity
        serial = identity.get("serialNumber")
        return [
            check_equal("厂商自检", result.get("result"), 0,
                        f"PXI4281_self_test 状态 {result.get('status')}: {result.get('message')}"),
            Check("序列号", bool(serial) and (self.serial is None or serial == self.serial), serial,
                  self.serial if self.serial is not None else "非零", f"PXI4281_GetSN，资源 {identity.get('resource')}"),
            Check("驱动与固件版本", identity.get("revisionStatus") == 0,
                  f"{identity.get('driverRevision')} / {identity.get('firmwareRevision')}", "可读",
                  "PXI4281_revision_query；自检只说明插件和板卡对上了，电容值须按 README 验收步骤用 LCR 表测量"),
        ]

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"channels": {"minimum": 0, "maximum": CHANNELS - 1},
                "capacitanceRange": {"minimum": MIN_PF, "maximum": MAX_PF, "unit": "pF"},
                "resolutionPf": 1.0, "accuracyPf": 0.5, "maxPowerW": 0.5, "safePf": self.safe_pf,
                "readback": False,
                "terminals": {f"C{n}": {"in": in_pin(n), "out": out_pin(n)} for n in range(CHANNELS)},
                "card": {"serialNumber": self.serial, "resource": self.resource_setting or None}}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
