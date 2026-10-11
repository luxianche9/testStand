"""Dry-run PXI2604: 40 relays k0..k39 with positions and operation counters."""

from __future__ import annotations

from .driver import CLOSED, OPEN

SIM_SERIAL = "SIM2604"


class SimulatedArtSwitch:
    def __init__(self) -> None:
        self.positions = {f"k{n}": OPEN for n in range(40)}
        self.counts = {f"k{n}": 10 + n for n in range(40)}
        self.controls: list[tuple[tuple[str, ...], bool]] = []
        self.stuck: set[str] = set()

    def open(self, resource: str) -> tuple[int, int]:
        return (0, 1) if resource == "Dev1" else (-1074118654, 0)

    def close(self, vi: int) -> int:
        return 0

    def error(self, vi: int) -> str:
        return "simulated error"

    def identity(self, vi: int) -> dict[str, str]:
        return {"model": "PXI2604", "serialNumber": SIM_SERIAL, "driverRevision": "1.0",
                "firmwareRevision": "V3.134.100"}

    def relay_names(self, vi: int, limit: int = 64) -> list[str]:
        return list(self.positions)

    def position(self, vi: int, relay: str) -> tuple[int, int]:
        if relay not in self.positions:
            return -1, 0
        return 0, self.positions[relay]

    def count(self, vi: int, relay: str) -> tuple[int, int]:
        return 0, self.counts[relay]

    def control(self, vi: int, relays: list[str], close: bool) -> int:
        self.controls.append((tuple(relays), close))
        for relay in relays:
            target = CLOSED if close else OPEN
            if relay not in self.stuck and self.positions[relay] != target:
                self.positions[relay] = target
                self.counts[relay] += 1
        return 0

    def debounce(self, vi: int, max_ms: int) -> int:
        return 0
