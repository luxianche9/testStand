"""ART Technology PXI2604: 40 SPDT electromechanical relays (k0..k39) on a DIN41612-128 connector.

Hardware manual V6.00.02: per relay NCn / COMn / NOn, 100 V max, 1 A switch/carry, 60 W / 62.5 VA,
operate and release ≤ 3 ms, path resistance < 0.5 Ω new (≥ 1 Ω at end of life), mechanical life
1e8, electrical life 1e5-2.5e6 cycles by load. The card counts every relay's operations.

Driven through ART-SWITCH (IVI-Switch style, topology ``2604/40-SPDT``): relay ``closed``
(position 11) is the energized relay, COMn-NOn; ``open`` (10) is released, COMn-NCn (IVI relay
convention, checked by the README acceptance procedure). Positions are the driver's relay
state, not a contact measurement.
"""

from __future__ import annotations

from typing import Any

from teststand_device_sdk import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
    BitsStream,
    Check,
    Device,
    DeviceConfig,
    DeviceError,
    Pinout,
    check_equal,
    model,
    param,
    tool,
)

from .driver import CLOSED, ArtSwitchDriver
from .pinout import pinout as build_pinout
from .sim import SimulatedArtSwitch

PRODUCT = "PXI2604"
RELAYS = 40
WEAR_LIMIT = 100_000
"""Lowest rated electrical life in the manual (60 VDC, 1 A); the self-test flags relays beyond it."""

Relays = model("Pxi2604Relays", mask=(int, "Driver relay positions: bit n set = relay kn closed (COMn-NOn)."),
               closed=(list[int], "Closed relays, ascending."))
Relay = param(int, "Relay 0..39 (kn: NCn/COMn/NOn).", ge=0, le=RELAYS - 1)


def relays_of(mask: int) -> list[int]:
    return [bit for bit in range(RELAYS) if mask >> bit & 1]


class ArtPxi2604(Device):
    manufacturer = "ART Technology"
    model = PRODUCT
    prefix = "pxi2604"
    capabilities = ("relay_switching",)
    isolation = "subprocess"
    version = "1.0.0"
    instructions = ("PXI2604: 40 SPDT relays k0..k39. closed = COMn-NOn, open = COMn-NCn. set_relay / set_relays "
                    "switch, wait for debounce and read the positions back; safe_state opens all.")
    description = ("ART Technology PXI2604, PXI general-purpose switch: 40 SPDT electromechanical relays "
                   "(NC/COM/NO each), 100 V, 1 A, 60 W, ≤ 3 ms operate/release, DIN41612-128 connector, "
                   "per-relay operation counters. Driven through ART-SWITCH (topology 2604/40-SPDT).")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.resource = str(settings.get("resourceName", "Dev1"))
        serial = settings.get("serialNumber")
        self.serial = str(serial) if serial not in (None, "") else None
        self.debounce_ms = int(settings.get("debounceMs", 100))
        if not 1 <= self.debounce_ms <= 10_000:
            raise ValueError("debounceMs must be within 1..10000")
        self.driver = self.select_driver(lambda: ArtSwitchDriver(settings.get("dllPath")), SimulatedArtSwitch)
        self.vi: int | None = None
        self.identity: dict[str, Any] = {}
        self.shadow = 0
        self.relays = self.streams.add(BitsStream("relays", bit_labels=[f"K{n}" for n in range(RELAYS)],
                                                  label="Relay positions (1 = COM-NO)", display="switches",
                                                  kind="measured"))

    # --- lifecycle ----------------------------------------------------
    def _check(self, rc: int, what: str, **details: Any) -> None:
        if rc < 0:
            message = self.driver.error(self.vi) if self.vi is not None else ""
            raise DeviceError(f"{what} failed ({rc}): {message}", category=DEVICE_ERROR, details={"rc": rc, **details})

    def open(self) -> dict[str, Any]:
        rc, vi = self.driver.open(self.resource)
        if rc < 0:
            raise DeviceError(f"ART-SWITCH init of {self.resource!r} failed ({rc}): {self.driver.error(vi)}",
                              category=DEVICE_UNREACHABLE)
        identity = {**self.driver.identity(vi), "resource": self.resource}
        names = self.driver.relay_names(vi)
        if identity["model"] != PRODUCT or len(names) != RELAYS or (
                self.serial is not None and identity["serialNumber"] != self.serial):
            self.driver.close(vi)
            raise DeviceError(f"{self.resource} is {identity['model']} SN {identity['serialNumber']} with "
                              f"{len(names)} relays, expected {PRODUCT} SN {self.serial or 'any'} with {RELAYS}",
                              category=DEVICE_UNREACHABLE, details=identity)
        self.vi, self.identity = vi, identity
        self._apply(0)
        return {"identity": identity}

    def close(self) -> dict[str, Any]:
        vi, self.vi = self.vi, None
        if vi is not None:
            self.driver.control(vi, [f"k{n}" for n in range(RELAYS)], False)
            self.driver.close(vi)
        return {"closed": vi is not None}

    def _require(self) -> int:
        if self.vi is None:
            raise DeviceError("Switch not open.", category=DEVICE_UNREACHABLE)
        return self.vi

    def _positions(self) -> int:
        vi = self._require()
        mask = 0
        for n in range(RELAYS):
            rc, position = self.driver.position(vi, f"k{n}")
            self._check(rc, "GetRelayPosition", relay=n)
            mask |= (position == CLOSED) << n
        return mask

    def _apply(self, mask: int) -> dict[str, Any]:
        """Close the relays in ``mask`` and open the others that differ, wait for debounce, read back."""
        vi = self._require()
        current = self._positions()
        to_close = relays_of(mask & ~current)
        to_open = relays_of(current & ~mask)
        for relays, close in ((to_open, False), (to_close, True)):
            if relays:
                self._check(self.driver.control(vi, [f"k{n}" for n in relays], close), "RelayControl",
                            relays=relays, close=close, relaysMayHaveMoved=True)
        self.shadow = mask
        self._check(self.driver.debounce(vi, self.debounce_ms), "WaitForDebounce")
        back = self._positions()
        self.relays.publish(back)
        if back != mask:
            raise DeviceError(f"relay positions {back:#012x} after requesting {mask:#012x}", category=DEVICE_ERROR,
                              details={"requested": mask, "readBack": back, "differ": relays_of(back ^ mask)})
        return {"mask": back, "closed": relays_of(back)}

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=Relays, safety_action="safe_state", effects=("relay_switched",),
          description="Close (COMn-NOn) or open (COMn-NCn) one relay, wait for debounce (≤ debounceMs) and read every "
                      "relay position back; other relays keep their state. Positions are driver state, not a contact "
                      "measurement. Max 100 V, 1 A.")
    def set_relay(self, relay: Relay, closed: param(bool, "true = COM-NO, false = COM-NC.")) -> dict[str, Any]:
        current = self._positions()
        return self._apply(current | 1 << relay if closed else current & ~(1 << relay))

    @tool(kind="actuate", output=Relays, safety_action="safe_state", effects=("relay_switched",),
          description="Close or open several relays in one driver call, wait for debounce and read every position "
                      "back; relays not listed keep their state.")
    def set_relays(self, relays: param(list[Relay], "Relays 0..39 to change.", min_length=1, max_length=RELAYS),
                   closed: param(bool, "true = COM-NO, false = COM-NC.")) -> dict[str, Any]:
        bits = 0
        for relay in relays:
            bits |= 1 << relay
        current = self._positions()
        return self._apply(current | bits if closed else current & ~bits)

    @tool(kind="read", output=Relays, evidence="controller_state",
          description="Read all 40 relay positions from the driver (bit n = kn closed, COMn-NOn). Driver state, "
                      "not a contact measurement.")
    def read_relays(self) -> dict[str, Any]:
        mask = self._positions()
        return {"mask": mask, "closed": relays_of(mask)}

    @tool(kind="safe", output=Relays,
          description="Open all 40 relays (every COM back to NC), wait for debounce and read the positions back.")
    def safe_state(self) -> dict[str, Any]:
        return self._apply(0)

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        vi = self._require()
        identity = self.identity
        names = self.driver.relay_names(vi)
        counts = {}
        for n in range(RELAYS):
            rc, count = self.driver.count(vi, f"k{n}")
            counts[n] = count if rc >= 0 else None
        known = {n: count for n, count in counts.items() if count is not None}
        worst = max(known, key=known.__getitem__) if known else None
        positions = self._positions()
        return [
            check_equal("产品型号", identity.get("model"), PRODUCT, f"ART-SWITCH 资源 {self.resource}"),
            Check("序列号", bool(identity.get("serialNumber")) and
                  (self.serial is None or identity.get("serialNumber") == self.serial),
                  identity.get("serialNumber"), self.serial or "非空",
                  f"固件 {identity.get('firmwareRevision')}，驱动 {identity.get('driverRevision')}"),
            check_equal("继电器数", len(names), RELAYS, "artSwitch_GetRelayName，拓扑 2604/40-SPDT"),
            check_equal("继电器位置 = 最后设置", f"{positions:#012x}", f"{self.shadow:#012x}",
                        "artSwitch_GetRelayPosition × 40"),
            Check("继电器动作次数", len(known) == RELAYS and (worst is None or known[worst] < WEAR_LIMIT),
                  {"max": known.get(worst) if worst is not None else None, "relay": worst,
                   "unreadable": [n for n, count in counts.items() if count is None]},
                  f"< {WEAR_LIMIT}",
                  "板载计数器；手册电气寿命最低 1e5 次（60 VDC 1 A），超过时检查路径电阻（新 < 0.5 Ω，寿命终止 ≥ 1 Ω）"),
        ]

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"relays": RELAYS, "form": "SPDT", "closed": "COM-NO", "open": "COM-NC", "maxVolts": 100,
                "maxAmps": 1.0, "maxWatts": 60, "operateMs": 3, "debounceMs": self.debounce_ms,
                "contactSensing": False, "operationCounters": True,
                "card": {"resourceName": self.resource, "serialNumber": self.serial}}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
