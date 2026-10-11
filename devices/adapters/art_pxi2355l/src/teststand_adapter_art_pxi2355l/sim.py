"""Dry-run PXI2355L: one ART-DAQ device ``Dev2`` with a 32-bit DI and a 32-bit DO register.

``loopback`` copies the DO register onto the DI levels, as if each output line were wired to the
input line with the same number.
"""

from __future__ import annotations

SIM_SERIAL = 1015182004


class SimulatedArtDaq:
    def __init__(self) -> None:
        self.di = 0
        self.do = 0
        self.loopback = False
        self.writes: list[int] = []
        self.tasks: dict[int, bool] = {}
        self.fail_write = False

    def last_error(self) -> str:
        return "simulated error"

    def devices(self) -> list[str]:
        return ["Dev2"]

    def identity(self, device: str) -> dict[str, object]:
        return {"device": device, "productType": "PXI2355L", "serialNumber": SIM_SERIAL, "rc": 0}

    def create(self, device: str, output: bool) -> tuple[int, int | None]:
        if device != "Dev2":
            return -200220, None
        task = len(self.tasks) + 1
        self.tasks[task] = output
        return 0, task

    def clear(self, task: int) -> int:
        self.tasks.pop(task, None)
        return 0

    def read(self, task: int) -> tuple[int, int]:
        if self.tasks.get(task):
            return 0, self.do
        return 0, self.do if self.loopback else self.di

    def write(self, task: int, mask: int) -> int:
        if self.fail_write:
            return -200000
        self.do = mask & 0xFFFFFFFF
        self.writes.append(self.do)
        return 0

    def power_up(self, device: str) -> tuple[int, list[str]]:
        return 0, ["low"] * 32
