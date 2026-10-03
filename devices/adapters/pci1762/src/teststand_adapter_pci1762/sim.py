"""Dry-run hwcli_pci1762.

Payload shapes match devices/native/hwcli_pci1762.cpp field for field. Modelled: the
open gate and the relay register a readback depends on. Not modelled: the
sixteen isolated DI lines, which come from whatever is wired; they read low.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _ok(message: str, data: Any) -> dict[str, Any]:
    return {"ok": True, "reachable": True, "message": f"DRY_RUN {message}", "data": data}


class SimulatedHwcli:
    def __init__(self) -> None:
        self.opened = False
        self.relays = 0
        self.di = 0
        self.commands: list[dict[str, Any]] = []

    def stop(self) -> None:
        self.opened = False

    def call(self, command: Mapping[str, Any]) -> dict[str, Any]:
        self.commands.append(dict(command))
        name = command.get("cmd")
        if name == "enumerate":
            return _ok("enumerate", [{"index": 0, "deviceNumber": 0, "description": "DemoDevice,BID#0"},
                                     {"index": 1, "deviceNumber": 1, "description": "PCI-1762,BID#0"}])
        if name == "open":
            self.opened = True
            self.relays = 0
            return _ok("opened", {"description": command.get("description", "PCI-1762,BID#0"), "portCount": 2})
        if name in ("ping", "self_test"):
            return _ok(str(name), dict(command))
        # The real CLI answers "Not open" for everything touching the board.
        if not self.opened:
            return {"ok": False, "reachable": True, "message": "DRY_RUN Not open", "data": None}
        if name == "set_relay":
            channel = int(command.get("channel", 0))
            closed = bool(command.get("closed", False))
            self.relays = self.relays | 1 << channel if closed else self.relays & ~(1 << channel)
            return _ok("relay closed (actuates)" if closed else "relay opened",
                       {"channel": channel, "closed": closed, "port": channel // 8, "bit": channel % 8})
        if name == "set_bank":
            self.relays = int(command.get("mask", 0)) & 0xFFFF
            return _ok("set_bank written (actuates)", {"mask": self.relays})
        if name == "read_bit":
            channel = int(command.get("channel", 0))
            kind = str(command.get("kind", "DI")).upper()
            register = self.relays if kind in ("RELAY", "DO") else self.di
            return _ok("read_bit", {"kind": kind, "channel": channel, "value": bool(register >> channel & 1)})
        if name == "read_mask":
            kind = str(command.get("kind", "DI")).upper()
            return _ok("read_mask", {"kind": kind, "mask": self.relays if kind in ("RELAY", "DO") else self.di})
        if name == "safe_state":
            self.relays = 0
            return _ok("All relays opened (safe_state)", {"relays": "all_open"})
        if name == "close":
            self.relays = 0
            self.opened = False
            return _ok("Closed after safe_state", {"open": False})
        return {"ok": False, "reachable": False, "message": f"DRY_RUN unknown {name}", "data": None}
