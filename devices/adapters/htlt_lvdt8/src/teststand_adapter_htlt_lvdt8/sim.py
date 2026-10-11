"""Dry-run PXI68802W: 8 channels following the output law measured on the real board.

3/4-wire: VA = Vexc·tr·(1+A)/2, VB = Vexc·tr·(1-A)/2; 2-wire: VA = Vexc·tr·|A|, VB = Vexc·tr·|B|.
External excitation per channel is ``external[channel]`` (Vrms, Hz); like the board, a disabled channel
answers reads with HTLT_CHANNEL_NOT_ENABLE (21).
"""

from __future__ import annotations

SIM_SERIAL = 25021215


class SimulatedHtlt:
    def __init__(self) -> None:
        self.external = {channel: (0.0, 0.0) for channel in range(8)}
        self.state = {channel: self._reset() for channel in range(8)}
        self.updates: list[tuple[int, float, float, float]] = []

    @staticmethod
    def _reset() -> dict[str, object]:
        return {"enabled": False, "internal": False, "twoWire": False, "exc": (0.0, 0.0), "excOn": False,
                "tr": 0.0, "a": 0.0, "b": 0.0}

    def open(self, board_id: int, serial: int | None) -> tuple[int, int | None]:
        if serial not in (None, SIM_SERIAL):
            return 22, None
        return (0, 1) if serial is not None or board_id == 1 else (13, None)

    def close(self, handle: int) -> int:
        return 0

    def identity(self, handle: int) -> dict[str, object]:
        return {"serialNumber": SIM_SERIAL, "hwVersion": 0x24020200, "snRc": 0, "sdkVersion": "2.1",
                "driverVersion": "2.1"}

    def reset_channel(self, handle: int, channel: int) -> int:
        self.state[channel] = self._reset()
        return 0

    def enable(self, handle: int, channel: int, on: bool) -> int:
        self.state[channel]["enabled"] = on
        return 0

    def mode(self, handle: int, channel: int, internal: bool, two_wire: bool) -> int:
        self.state[channel].update(internal=internal, twoWire=two_wire)
        return 0

    def internal_excitation(self, handle: int, channel: int, volts: float, freq: float, on: bool) -> int:
        if on and not (2 <= volts <= 7 and 100 <= freq <= 20000):
            return 23
        self.state[channel].update(exc=(volts, freq) if on else self.state[channel]["exc"], excOn=on)
        return 0

    def update(self, handle: int, channel: int, ratio: float, a: float, b: float) -> int:
        if not 0 <= ratio <= 10:
            return 19
        if not (-1 <= a <= 1 and -1 <= b <= 1):
            return 5
        self.state[channel].update(tr=ratio, a=a, b=b)
        self.updates.append((channel, ratio, a, b))
        return 0

    def read_excitation(self, handle: int, channel: int) -> tuple[int, float, float]:
        state = self.state[channel]
        if not state["enabled"]:
            return 21, 0.0, 0.0
        volts, freq = state["exc"] if state["internal"] and state["excOn"] else self.external[channel]
        return 0, volts, freq

    def read_output(self, handle: int, channel: int) -> tuple[int, float, float]:
        state = self.state[channel]
        if not state["enabled"]:
            return 21, 0.0, 0.0
        _, volts, _ = self.read_excitation(handle, channel)
        gain = volts * state["tr"]
        if state["twoWire"]:
            return 0, gain * abs(state["a"]), gain * abs(state["b"])
        return 0, gain * (1 + state["a"]) / 2, gain * (1 - state["a"]) / 2
