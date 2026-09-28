"""Dry-run hwcli_pci1710l.

Payload shapes match native/hwcli_pci1710l.cpp field for field: a dry run
whose shape differs from the real board validates a graph that will not run.

Modelled: the open gate, the DO register (readback of your own stimulus) and
the configure_ai-before-read_voltage precondition. Not modelled: DI and the
AI voltage, which come from whatever is wired to the connector. DI reads
false and AI reads 0.0 V unless ``HARDWARE_DRY_RUN_AI_NOISE=1`` opts into
demo values.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from hardwareharness_device_sdk.sim import ai_noise_enabled, demo_voltage

SIGNAL_NAMES = {0: "SingleEnded", 1: "Differential", 2: "PseudoDifferential"}


def _ok(message: str, data: Any) -> dict[str, Any]:
    return {"ok": True, "reachable": True, "message": f"DRY_RUN {message}", "data": data}


class SimulatedHwcli:
    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self.noise = ai_noise_enabled(env)
        self.opened = False
        self.safe_do_mask = 0
        self.do = 0
        self.di = 0
        self.ai_config: dict[int, dict[str, int]] = {}
        self.commands: list[dict[str, Any]] = []

    def stop(self) -> None:
        self.opened = False

    def call(self, command: Mapping[str, Any]) -> dict[str, Any]:
        self.commands.append(dict(command))
        name = command.get("cmd")
        if name == "open":
            self.opened = True
            self.safe_do_mask = int(command.get("safe_do_mask", 0))
            self.do = self.safe_do_mask
            self.ai_config.clear()
            return _ok("opened", {"description": command.get("description", "PCI-1710L,BID#15"),
                                  "safe_do_mask": self.safe_do_mask})
        if name in ("ping", "enumerate", "self_test"):
            return _ok(str(name), dict(command))
        # The real CLI answers "Not open" for everything touching the board.
        if not self.opened:
            return {"ok": False, "reachable": True, "message": "DRY_RUN Not open", "data": None}
        if name == "configure_ai":
            channel = int(command.get("channel", 0))
            signal_type = int(command.get("signal_type", 0))
            value_range = int(command.get("value_range", 1))
            self.ai_config[channel] = {"signal_type": signal_type, "value_range": value_range}
            return _ok("AI channel configured", {"channel": channel, "signal_type": signal_type,
                                                 "value_range": value_range,
                                                 "signal": SIGNAL_NAMES.get(signal_type, "SingleEnded")})
        if name == "read_voltage":
            channel = int(command.get("channel", 0))
            config = self.ai_config.get(channel)
            if config is None:
                return {"ok": False, "reachable": True,
                        "message": "DRY_RUN AI channel not configured — call configure_ai first", "data": None}
            volts = demo_voltage(channel) if self.noise else 0.0
            return _ok(f"AI{channel} = {volts} V", {"channel": channel, "volts": volts, "raw": 0,
                                                    "signal": SIGNAL_NAMES.get(config["signal_type"], "SingleEnded"),
                                                    "value_range": config["value_range"]})
        if name == "set_level":
            channel = int(command.get("channel", 0))
            level = bool(command.get("level", False))
            self.do = self.do | 1 << channel if level else self.do & ~(1 << channel)
            return _ok("DO set (actuates)", {"channel": channel, "level": level})
        if name == "read_bit":
            channel = int(command.get("channel", 0))
            kind = str(command.get("kind", "DI"))
            register = self.do if kind.upper() == "DO" else self.di
            return _ok("read_bit", {"kind": kind, "channel": channel, "value": bool(register >> channel & 1)})
        if name == "safe_state":
            self.do = self.safe_do_mask
            return _ok("DO safe_state applied", {"safe_do_mask": self.safe_do_mask})
        if name == "close":
            self.do = self.safe_do_mask
            self.opened = False
            return _ok("Closed after safe_state", {"open": False})
        return {"ok": False, "reachable": False, "message": f"DRY_RUN unknown {name}", "data": None}
