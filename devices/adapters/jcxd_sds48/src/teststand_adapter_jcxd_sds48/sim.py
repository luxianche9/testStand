"""Dry-run SDS48: two cards (ids 0 and 1) with a 48-bit relay register each."""

from __future__ import annotations

SIM_SERIALS = (637797222, 637797221)


class SimulatedSds48:
    def __init__(self) -> None:
        self.masks = [0, 0]
        self.writes: list[int] = []
        self.stuck = 0
        """Bits the simulated register refuses to change (a failed relay driver)."""

    def open(self, card_id: int) -> tuple[int, int | None]:
        if card_id not in (0, 1):
            return -2, None
        return 0, card_id + 1

    def close(self, h: int) -> int:
        return 0

    def reset(self, h: int) -> int:
        self.masks[h - 1] = 0
        return 0

    def info(self, h: int) -> tuple[int, dict[str, int]]:
        return 0, {"cardType": 0x5205, "hwVersion": 0x1000000, "driverVersion": 0x26031801, "libVersion": 0x10001,
                   "boardId": 0, "serialNumber": SIM_SERIALS[h - 1], "channelMax": 48}

    def serial(self, h: int) -> tuple[int, int]:
        return 0, SIM_SERIALS[h - 1]

    def set_mask(self, h: int, mask: int) -> int:
        old = self.masks[h - 1]
        self.masks[h - 1] = (mask & ~self.stuck) | (old & self.stuck)
        self.writes.append(mask)
        return 0

    def get_mask(self, h: int) -> tuple[int, int]:
        return 0, self.masks[h - 1]

    def get_single(self, h: int, channel: int) -> tuple[int, int]:
        if not 0 <= channel < 48:
            return -3, 0
        return 0, (self.masks[h - 1] >> channel) & 1
