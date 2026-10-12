"""Dry-run JCXD-MADS-X-3210: AD frames generated from elapsed time, DIO/DA/CT registers in memory.

AI channel n reads ``0.1 * n`` V plus a 0.5 V, 5 Hz sine on channel 0, encoded the way the card
returns words (bits 29..24 channel, bits 15..0 offset-binary code for ±10 V).
"""

from __future__ import annotations

import math
import time

SIM_SERIAL = 621216518


def encode(volts: float) -> int:
    return max(0, min(0xFFFF, round(volts / 10.0 * 32768 + 32768)))


class SimulatedMads3210:
    def __init__(self) -> None:
        self.opened = False
        self.ad_channels: list[int] = []
        self.ad_rate = 0.0
        self.ad_started: float | None = None
        self.ad_sent = 0
        self.ad_skew = False
        self.da: dict[int, float] = {}
        self.waves: dict[int, tuple[int, float, float, float, float]] = {}
        self.di_lines: set[int] = set()
        self.do_lines: dict[int, int] = {}
        self.di_levels = (1 << 48) - 1
        self.counters: dict[int, tuple[str, float, float]] = {}
        self.calls: list[tuple] = []
        self.stale = False
        """Identity registers read 0 until reset, as after a process died mid-acquisition."""

    def open(self, card_id: int) -> tuple[int, int | None]:
        if card_id != 0:
            return -2, None
        self.opened = True
        return 0, 1

    def close(self, h: int) -> int:
        self.opened = False
        return 0

    def reset(self, h: int) -> int:
        self.stale = False
        self.ad_channels, self.ad_started = [], None
        self.da.clear()
        self.waves.clear()
        self.di_lines.clear()
        self.do_lines.clear()
        self.counters.clear()
        return 0

    def info(self, h: int) -> tuple[int, dict[str, int]]:
        if self.stale:
            return 0, {"cardType": 0, "hwVersion": 0x25072401, "driverVersion": 0x1000001,
                       "libVersion": 0x1000002, "boardId": 0, "serialNumber": 0, "channelMax": 32}
        return 0, {"cardType": 0x3210, "hwVersion": 0x25072401, "driverVersion": 0x1000001,
                   "libVersion": 0x1000002, "boardId": 0, "serialNumber": SIM_SERIAL, "channelMax": 32}

    # --- AI ---
    def ad_create(self, h: int, channels: list[int], mode: int) -> int:
        if not channels or any(not 0 <= c < (16 if mode else 32) for c in channels):
            return -3
        self.ad_channels = list(channels)
        return 0

    def ad_configure(self, h: int, aggregate_rate: float, depth: int) -> int:
        self.ad_rate = aggregate_rate
        return 0

    def ad_start(self, h: int) -> int:
        self.ad_started, self.ad_sent = time.perf_counter(), 0
        return 0

    def ad_stop(self, h: int) -> int:
        self.ad_started = None
        return 0

    def volts(self, channel: int, index: int) -> float:
        value = 0.1 * channel
        if channel == 0:
            frame_rate = self.ad_rate / len(self.ad_channels)
            value += 0.5 * math.sin(2 * math.pi * 5 * index / frame_rate)
        return value

    def ad_read(self, h: int, frame: int) -> tuple[int, list[int]]:
        if self.ad_started is None:
            return 0, []
        due = int((time.perf_counter() - self.ad_started) * self.ad_rate) // frame * frame
        words = []
        for word_index in range(self.ad_sent, due):
            slot = word_index % frame
            channel = self.ad_channels[(slot + 1) % frame if self.ad_skew else slot]
            words.append((channel << 24) | encode(self.volts(channel, word_index // frame)))
        self.ad_sent = due
        return 0, words

    def convert(self, code: int) -> float:
        return ((code & 0xFFFF) - 32768) / 32768 * 10.0

    # --- AO ---
    def da_create(self, h: int, channel: int) -> int:
        self.waves.pop(channel, None)
        self.da.setdefault(channel, 0.0)
        return 0

    def da_write(self, h: int, channel: int, volts: float) -> int:
        if channel not in self.da or channel in self.waves:
            return -3
        self.da[channel] = volts
        self.calls.append(("da", channel, volts))
        return 0

    def da_wave(self, h: int, channel: int, shape: int, amplitude: float, freq: float, phase: float,
                offset: float) -> int:
        self.waves[channel] = (shape, amplitude, freq, phase, offset)
        return 0

    def da_stop_wave(self, h: int, channel: int) -> int:
        return 0 if self.waves.pop(channel, None) is not None else -3

    # --- DIO ---
    def di_create(self, h: int, channel: int) -> int:
        self.do_lines.pop(channel, None)
        self.di_lines.add(channel)
        return 0

    def do_create(self, h: int, channel: int) -> int:
        self.di_lines.discard(channel)
        self.do_lines[channel] = 0
        return 0

    def di_read(self, h: int, channel: int) -> tuple[int, int]:
        if channel not in self.di_lines:
            return -3, 0
        return 0, (self.di_levels >> channel) & 1

    def do_write(self, h: int, channel: int, level: int) -> int:
        if channel not in self.do_lines:
            return -3
        self.do_lines[channel] = level
        self.calls.append(("do", channel, level))
        return 0

    def do_status(self, h: int, channel: int) -> tuple[int, int]:
        if channel not in self.do_lines:
            return -3, 0
        return 0, self.do_lines[channel]

    # --- counters ---
    def ct_frequency(self, h: int, channel: int) -> int:
        self.counters[channel] = ("frequency", 1000.0 * (channel + 1), 0.0)
        return 0

    def ct_count(self, h: int, channel: int) -> int:
        self.counters[channel] = ("count", 0.0, time.perf_counter())
        return 0

    def ct_pwm(self, h: int, channel: int, freq: float, duty: float) -> int:
        self.counters[channel] = ("pwm", freq, duty)
        return 0

    def ct_pwm_update(self, h: int, channel: int, freq: float, duty: float) -> int:
        if self.counters.get(channel, ("",))[0] != "pwm":
            return -3
        self.counters[channel] = ("pwm", freq, duty)
        return 0

    def ct_stop(self, h: int, channel: int) -> int:
        self.counters.pop(channel, None)
        return 0

    def ct_read_count(self, h: int, channel: int) -> tuple[int, int]:
        mode = self.counters.get(channel)
        if mode is None or mode[0] != "count":
            return -3, 0
        return 0, int((time.perf_counter() - mode[2]) * 100)

    def ct_read_frequency(self, h: int, channel: int) -> tuple[int, list[float]]:
        mode = self.counters.get(channel)
        if mode is None or mode[0] != "frequency":
            return -3, []
        return 0, [mode[1]]
