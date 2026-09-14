"""MCP stdio server for Advantech PCI-1762 (16 relays + 16 isolated DI)."""

from __future__ import annotations

import atexit
import logging
import os
import sys
from typing import Any, Optional

from mcp.server.mcpserver import MCPServer

from hardwareharness_remote import pci1762_sdk as sdk
from hardwareharness_remote.result import err, ok

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("advantech_pci1762")

mcp = MCPServer(
    name="advantech-pci1762",
    version="0.1.0",
    instructions=(
        "Advantech PCI-1762: 16 relays + 16 isolated DI. "
        "Select device by DAQNavi description string (bench default PCI-1762,BID#0). "
        "set_relay/set_bank ACTUATE. close/safe_state opens all relays. "
        "self_test never actuates."
    ),
)

_open = False


def _default_desc() -> str:
    return os.environ.get("ADVANTECH_PCI1762_DESC", "PCI-1762,BID#0")


def _wrap(resp: dict[str, Any]) -> dict[str, Any]:
    """Normalize CLI JSON into our result shape if needed."""
    if "ok" in resp:
        return resp
    return err("malformed CLI response", data=resp)


@mcp.tool()
def info() -> dict[str, Any]:
    """Server identity, hwcli path, env (no hardware access)."""
    return ok(
        "Advantech PCI-1762 MCP",
        data={
            "board": "PCI-1762",
            "hwcli": str(sdk.resolve_hwcli()) if sdk.resolve_hwcli() else None,
            "dry_run": sdk.dry_run(),
            "open": _open,
            "description": _default_desc(),
            "env": {
                "ADVANTECH_PCI1762_DESC": os.environ.get("ADVANTECH_PCI1762_DESC", "PCI-1762,BID#0"),
                "PCI1762_HWCLI_PATH": os.environ.get("PCI1762_HWCLI_PATH", os.environ.get("HWCLI_PATH")),
                "HARDWARE_DRY_RUN": os.environ.get("HARDWARE_DRY_RUN", ""),
            },
        },
    )


@mcp.tool()
def enumerate_devices() -> dict[str, Any]:
    """List DAQNavi devices (description strings). Read-only."""
    try:
        return _wrap(sdk.call({"cmd": "enumerate"}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def open(description: Optional[str] = None) -> dict[str, Any]:
    """Bind to device by description string. Does not change relay state."""
    global _open
    if _open:
        return err("Already open", reachable=True)
    desc = description or _default_desc()
    try:
        resp = _wrap(sdk.call({"cmd": "open", "description": desc}))
        if resp.get("ok"):
            _open = True
        return resp
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def close() -> dict[str, Any]:
    """safe_state (all relays open) then release. ACTUATES."""
    global _open
    try:
        resp = _wrap(sdk.call({"cmd": "close"}))
        _open = False
        return resp
    except sdk.SdkError as exc:
        _open = False
        return err(str(exc), reachable=False)


@mcp.tool()
def set_relay(channel: int, closed: bool) -> dict[str, Any]:
    """Set one relay RELAY0..15. ACTUATES — closed=true energizes the coil."""
    if channel < 0 or channel > 15:
        return err("channel must be 0..15", reachable=True)
    try:
        return _wrap(sdk.call({"cmd": "set_relay", "channel": channel, "closed": closed}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def set_bank(mask: int) -> dict[str, Any]:
    """Write 16-bit relay mask (bit0=RELAY0). ACTUATES. Same-port bits are atomic per 8."""
    if mask < 0 or mask > 0xFFFF:
        return err("mask must be 0..65535", reachable=True)
    try:
        return _wrap(sdk.call({"cmd": "set_bank", "mask": mask}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def read_bit(channel: int, kind: str = "DI") -> dict[str, Any]:
    """Read one bit. kind=DI or RELAY (DO readback)."""
    if channel < 0 or channel > 15:
        return err("channel must be 0..15", reachable=True)
    if kind.upper() not in ("DI", "RELAY", "DO"):
        return err("kind must be DI or RELAY", reachable=True)
    try:
        return _wrap(sdk.call({"cmd": "read_bit", "channel": channel, "kind": kind.upper()}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def safe_state() -> dict[str, Any]:
    """Open all 16 relays and verify readback. ACTUATES."""
    try:
        return _wrap(sdk.call({"cmd": "safe_state"}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def self_test(description: Optional[str] = None) -> dict[str, Any]:
    """Enumerate + bind check only. Never actuates relays."""
    desc = description or _default_desc()
    try:
        return _wrap(sdk.call({"cmd": "self_test", "description": desc}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


def _atexit() -> None:
    global _open
    if _open:
        try:
            close()
        except Exception as exc:  # noqa: BLE001
            log.warning("atexit close: %s", exc)
    sdk.stop()


atexit.register(_atexit)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
