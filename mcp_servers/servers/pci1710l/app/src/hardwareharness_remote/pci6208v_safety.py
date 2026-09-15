"""Range clamps and safe-state for PCI-6208V."""

from __future__ import annotations

import logging
import math
import os

from hardwareharness_remote import pci6208v_sdk as sdk
from hardwareharness_remote.pci6208v_state import CHANNEL_COUNT, STATE, VOLT_MAX, VOLT_MIN
from hardwareharness_remote.result import err, ok

log = logging.getLogger(__name__)


def env_safe_volts() -> float:
    raw = os.environ.get("ADLINK_SAFE_VOLTS", "0.0")
    try:
        v = float(raw)
    except ValueError:
        return 0.0
    return clamp_volts(v)


def clamp_volts(volts: float) -> float:
    if not math.isfinite(volts):
        raise ValueError("safe_volts must be finite")
    if volts < VOLT_MIN:
        return VOLT_MIN
    if volts > VOLT_MAX:
        return VOLT_MAX
    return volts


def validate_channel(channel: int) -> str | None:
    if channel < 0 or channel >= CHANNEL_COUNT:
        return f"channel must be 0..{CHANNEL_COUNT - 1}, got {channel}"
    return None


def require_open():
    if not STATE.open or STATE.handle is None:
        return err("Card not open. Call open first.", reachable=False)
    return None


def safe_state_impl():
    """Drive every channel to safe_volts. Actuates real outputs."""
    gate = require_open()
    if gate is not None:
        return gate

    if sdk.dry_run():
        for ch in range(CHANNEL_COUNT):
            STATE.last_volts[ch] = STATE.safe_volts
        return ok("DRY_RUN safe_state applied in memory", data={"safe_volts": STATE.safe_volts})

    failures = []
    for ch in range(CHANNEL_COUNT):
        rc = sdk.ao_vwrite_channel(STATE.handle, ch, STATE.safe_volts)
        if rc != 0:
            failures.append({"channel": ch, "rc": rc})
        else:
            STATE.last_volts[ch] = STATE.safe_volts

    if failures:
        return err(
            f"safe_state incomplete: {len(failures)} channel(s) failed",
            reachable=True,
            data={"failures": failures, "safe_volts": STATE.safe_volts},
        )
    return ok(
        f"All {CHANNEL_COUNT} channels driven to {STATE.safe_volts} V",
        data={"safe_volts": STATE.safe_volts},
    )
