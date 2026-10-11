"""Dry-run DA6401: one simulated card, records created channels and the values written."""

from __future__ import annotations

SIM_SERIAL = 637801473


class SimulatedDa6401:
    def __init__(self) -> None:
        self.opened: int | None = None
        self.channels: dict[int, int] = {}
        self.values: dict[int, float] = {}
        self.writes: list[tuple[int, float]] = []
        self.fail_write: set[int] = set()

    def open(self, card_id: int) -> tuple[int, int | None]:
        if card_id != 0:
            return -2, None
        self.opened = card_id
        return 0, 1

    def close(self, handle: int) -> int:
        self.opened = None
        return 0

    def reset(self, handle: int) -> int:
        self.channels.clear()
        self.values.clear()
        return 0

    def info(self, handle: int) -> tuple[int, dict[str, int]]:
        return 0, {"cardType": 0x4204, "hwVersion": 0x10000, "driverVersion": 0x10000, "libVersion": 0x20001,
                   "boardId": 0, "serialNumber": SIM_SERIAL, "channelMax": 64}

    def create_channel(self, handle: int, channel: int, mode: int) -> int:
        self.channels[channel] = mode
        return 0

    def write(self, handle: int, channel: int, value: float) -> int:
        if channel not in self.channels:
            return -5
        if channel in self.fail_write:
            return -1
        self.values[channel] = value
        self.writes.append((channel, value))
        return 0
