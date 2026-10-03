"""Dry-run PCIS-DASK: accepts every call and records the commanded outputs."""

from __future__ import annotations


class SimulatedDask:
    def __init__(self) -> None:
        self.registered: int | None = None
        self.outputs: dict[int, float] = {}
        self.writes: list[tuple[int, float]] = []

    def register(self, card_index: int) -> int:
        self.registered = card_index
        return 0

    def release(self, handle: int) -> int:
        self.registered = None
        return 0

    def write(self, handle: int, channel: int, volts: float) -> int:
        self.outputs[channel] = volts
        self.writes.append((channel, volts))
        return 0
