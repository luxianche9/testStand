from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from hardwareharness_remote.compat import install

install()

from hardwareharness_remote import cp118u, pci1710l, pci1762, pci6208v, pinouts  # noqa: E402


class AdapterError(RuntimeError):
    def __init__(self, message: str, *, category: str = "device_error", details: Any = None):
        super().__init__(message)
        self.category = category
        self.details = details


def _unwrap(result: dict[str, Any]) -> Any:
    if result.get("ok"):
        return result.get("data")
    category = "device_unreachable" if not result.get("reachable", False) else "device_error"
    raise AdapterError(result.get("message", "Hardware operation failed"), category=category, details=result.get("data"))


@dataclass
class HardwareAdapter:
    hardware_id: str
    manufacturer: str
    model: str
    capabilities: list[str]
    open_fn: Callable[..., dict[str, Any]]
    safe_fn: Callable[..., dict[str, Any]] | None
    close_fn: Callable[..., dict[str, Any]]
    operations: dict[str, Callable[..., dict[str, Any]]]
    pinout: pinouts.Pinout
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def _call(self, fn: Callable[..., dict[str, Any]], **kwargs: Any) -> Any:
        async with self.lock:
            return _unwrap(await asyncio.to_thread(fn, **kwargs))

    async def open(self) -> Any:
        return await self._call(self.open_fn)

    async def safe(self) -> Any:
        return {"safe": True, "action": "none"} if self.safe_fn is None else await self._call(self.safe_fn)

    async def close(self) -> Any:
        return await self._call(self.close_fn)

    async def invoke(self, operation: str, **kwargs: Any) -> Any:
        fn = self.operations.get(operation)
        if fn is None:
            raise AdapterError(f"Unsupported operation: {operation}", category="invalid_argument")
        return await self._call(fn, **kwargs)


def _server_config() -> dict[str, Any]:
    path = os.environ.get("HARDWAREHARNESS_SERVER_CONFIG")
    if not path:
        raise RuntimeError("HARDWAREHARNESS_SERVER_CONFIG is required")
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def build_adapters() -> list[HardwareAdapter]:
    config = _server_config()
    server_id = config["serverId"]
    hardware_id = config["hardwareId"]
    definitions: dict[str, dict[str, Any]] = {
        "PCI1710L_MCP": dict(manufacturer="Advantech", model="PCI-1710L", capabilities=["analog_input", "digital_input", "digital_output"], open_fn=pci1710l.open, safe_fn=pci1710l.safe_state, close_fn=pci1710l.close, operations={"configure_ai": pci1710l.configure_ai, "read_voltage": pci1710l.read_voltage, "read_bit": pci1710l.read_bit, "set_level": pci1710l.set_level, "safe_state": pci1710l.safe_state}),
        "PCI1762_MCP": dict(manufacturer="Advantech", model="PCI-1762", capabilities=["relay_output", "digital_input"], open_fn=pci1762.open, safe_fn=pci1762.safe_state, close_fn=pci1762.close, operations={"set_relay": pci1762.set_relay, "set_bank": pci1762.set_bank, "read_bit": pci1762.read_bit, "safe_state": pci1762.safe_state}),
        "PCI6208V_MCP": dict(manufacturer="ADLINK", model="PCI-6208V", capabilities=["analog_output"], open_fn=pci6208v.open, safe_fn=pci6208v.safe_state, close_fn=pci6208v.close, operations={"set_voltage": pci6208v.set_voltage, "read_last": pci6208v.read_last, "safe_state": pci6208v.safe_state}),
        "CP118U_I_MCP": dict(manufacturer="Moxa", model="CP-118U-I", capabilities=["serial_rs232_rs422_rs485"], open_fn=cp118u.open, safe_fn=None, close_fn=cp118u.close, operations={"configure_port": cp118u.configure_port, "write_text": cp118u.write_text, "write_hex": cp118u.write_hex, "read_rx": cp118u.read_rx, "clear_rx": cp118u.clear_rx, "flush": cp118u.flush, "get_line_status": cp118u.get_line_status}),
    }
    selected = definitions.get(server_id)
    if selected is None:
        raise RuntimeError(f"Unsupported serverId: {server_id}")
    if selected["manufacturer"] != config["manufacturer"] or selected["model"] != config["model"]:
        raise RuntimeError("server.json manufacturer/model does not match the implemented driver")
    return [HardwareAdapter(hardware_id=hardware_id, pinout=pinouts.get_pinout_data(hardware_id), **selected)]
