"""Dry-run support: ``HARDWARE_DRY_RUN=1`` swaps the vendor driver for a simulator.

Simulators must model controller state (registers, shadows, configuration
gates) faithfully but never invent physical measurements by default: inputs
read as their idle value (0 V, logic low, no RX). Demo-only behaviour is
opt-in through environment flags so a dry-run result cannot be mistaken for
evidence.
"""

from __future__ import annotations

import random
from collections.abc import Mapping

from .config import env_flag

AI_NOISE_ENV = "HARDWARE_DRY_RUN_AI_NOISE"
SERIAL_LOOPBACK_ENV = "HARDWARE_DRY_RUN_SERIAL_LOOPBACK"

EXECUTION_HARDWARE = "hardware"
EXECUTION_DRY_RUN = "nonphysical_driver_override"


def ai_noise_enabled(env: Mapping[str, str] | None = None) -> bool:
    return env_flag(AI_NOISE_ENV, env)


def serial_loopback_enabled(env: Mapping[str, str] | None = None) -> bool:
    return env_flag(SERIAL_LOOPBACK_ENV, env)


def demo_voltage(channel: int, *, amplitude: float = 0.05, rng: random.Random | None = None) -> float:
    """Small deterministic-offset noise for demos; only used when AI noise is opted in."""
    source = rng or random
    return round(0.1 * channel + source.uniform(-amplitude, amplitude), 6)


def execution_mode(dry_run: bool) -> str:
    return EXECUTION_DRY_RUN if dry_run else EXECUTION_HARDWARE
