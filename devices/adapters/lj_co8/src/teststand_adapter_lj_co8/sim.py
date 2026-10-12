"""Dry-run hwcli_lj_co8.

Payload shapes match devices/native/hwcli_lj_co8.cpp field for field. Modelled: the open gate, the
5..1000 pF / channel 0..7 checks the bridge repeats, and the value each channel was last set to
(the card itself has no readback). One card is simulated; ``cards`` can be extended in tests.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

SIM_RESOURCE = "PXI13::13::INSTR"
SIM_SERIAL = 26092002
CHANNELS = 8
MIN_PF, MAX_PF = 5.0, 1000.0


def _ok(message: str, data: Any) -> dict[str, Any]:
    return {"ok": True, "reachable": True, "message": f"DRY_RUN {message}", "data": data}


def _fail(message: str, reachable: bool = True) -> dict[str, Any]:
    return {"ok": False, "reachable": reachable, "message": f"DRY_RUN {message}", "data": None}


def _valid(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and MIN_PF <= value <= MAX_PF


class SimulatedHwcli:
    def __init__(self) -> None:
        self.cards: dict[str, int] = {SIM_RESOURCE: SIM_SERIAL}
        self.resource: str | None = None
        self.values: list[float | None] = [None] * CHANNELS
        self.commands: list[dict[str, Any]] = []
        self.fail_set = False

    def stop(self) -> None:
        self.resource = None

    def call(self, command: Mapping[str, Any]) -> dict[str, Any]:
        self.commands.append(dict(command))
        name = command.get("cmd")
        if name == "ping":
            return _ok("pong", {})
        if name == "enumerate":
            listed = [{"resource": resource, "slot": 65535} for resource in self.cards]
            return _ok(f"{len(listed)} card(s)", listed)
        if name == "open":
            resource = str(command.get("resource") or next(iter(self.cards), ""))
            if resource not in self.cards:
                return _fail(f"Card '{resource}' cannot be opened", reachable=False)
            self.resource = resource
            return _ok("opened", {"resource": resource, "serialNumber": self.cards[resource], "snStatus": 0,
                                  "dll": "PXI4281.dll"})
        if name == "close":
            self.resource = None
            return _ok("closed", {"open": False})
        # The real CLI answers "Not open" for everything touching the board.
        if self.resource is None:
            return _fail("Not open")
        if name == "identity":
            return _ok("identity", {"resource": self.resource, "serialNumber": self.cards[self.resource],
                                    "snStatus": 0, "driverRevision": "PXI4281.dll:V1.1",
                                    "firmwareRevision": "FPGA: V0.8", "revisionStatus": 0, "dll": "PXI4281.dll"})
        if name == "set_cap":
            channel, pf = command.get("channel"), command.get("pf")
            if not isinstance(channel, int) or not 0 <= channel < CHANNELS:
                return _fail("channel must be 0..7")
            if not _valid(pf):
                return _fail("pf must be a number in 5..1000")
            if self.fail_set:
                return _fail("PXI4281_capSetCapacitance failed status -1 (0xFFFFFFFF)")
            self.values[channel] = float(pf)
            return _ok("capacitance set (actuates)", {"channel": channel, "pf": pf})
        if name == "set_all":
            values = [command.get(f"pf{n}") for n in range(CHANNELS)]
            for n, value in enumerate(values):
                if not _valid(value):
                    return _fail(f"pf{n} must be a number in 5..1000")
            if self.fail_set:
                return _fail("PXI4281_capSetCapacitanceAll failed status -1 (0xFFFFFFFF)")
            self.values = [float(value) for value in values]  # type: ignore[arg-type]
            return _ok("all capacitances set (actuates)", {"pf": values})
        if name == "reset":
            return _ok("reset (actuates)", {})
        if name == "self_test":
            return _ok("self_test", {"status": 0, "result": 0, "message": "PXI4281 is working properly"})
        return _fail(f"Unknown command {name}", reachable=False)
