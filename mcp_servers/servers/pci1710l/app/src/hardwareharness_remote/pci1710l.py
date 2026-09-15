"""MCP stdio server for Advantech PCI-1710L (16 AI + 16 DI + 16 DO)."""

from __future__ import annotations

import atexit
import logging
import os
import sys
from typing import Any, Optional

from mcp.server.mcpserver import MCPServer

from hardwareharness_remote import pci1710l_sdk as sdk
from hardwareharness_remote.result import err, ok

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("advantech_pci1710l")

mcp = MCPServer(
    name="advantech-pci1710l",
    version="0.1.0",
    instructions=(
        "Advantech PCI-1710L: 16 AI + 16 DI + 16 DO (no AO on L model). "
        "Bench description default PCI-1710L,BID#15. "
        "configure_ai before read_voltage. set_level ACTUATES DO. "
        "close/safe_state applies SAFE_DO_MASK (default 0). self_test never writes DO."
    ),
)

_open = False
_active_safe_do_mask: int | None = None

# Common ValueRange enums from this card's probe (static table for tool docs).
VALUE_RANGE_HINT = {
    1: "±10 V",
    2: "±5 V",
    3: "±2.5 V",
    4: "±1.25 V",
    12: "±625 mV",
    7: "0~10 V",
    8: "0~5 V",
    9: "0~2.5 V",
    10: "0~1.25 V",
}


def _default_desc() -> str:
    return os.environ.get("ADVANTECH_PCI1710L_DESC", "PCI-1710L,BID#15")


def _safe_mask() -> int:
    raw = os.environ.get("SAFE_DO_MASK", "0")
    try:
        return int(raw, 0) & 0xFFFF
    except ValueError:
        return 0


def _wrap(resp: dict[str, Any]) -> dict[str, Any]:
    if "ok" in resp:
        return resp
    return err("malformed CLI response", data=resp)


@mcp.tool()
def info() -> dict[str, Any]:
    """Server identity, hwcli path, env (no hardware access)."""
    return ok(
        "Advantech PCI-1710L MCP",
        data={
            "board": "PCI-1710L",
            "hwcli": str(sdk.resolve_hwcli()) if sdk.resolve_hwcli() else None,
            "dry_run": sdk.dry_run(),
            "open": _open,
            "description": _default_desc(),
            "safe_do_mask": _safe_mask(),
            "value_range_hint": VALUE_RANGE_HINT,
            "signal_type_hint": {"0": "SingleEnded", "1": "Differential"},
            "env": {
                "ADVANTECH_PCI1710L_DESC": os.environ.get("ADVANTECH_PCI1710L_DESC", "PCI-1710L,BID#15"),
                "SAFE_DO_MASK": os.environ.get("SAFE_DO_MASK", "0"),
                "PCI1710L_HWCLI_PATH": os.environ.get("PCI1710L_HWCLI_PATH", os.environ.get("HWCLI_PATH")),
                "HARDWARE_DRY_RUN": os.environ.get("HARDWARE_DRY_RUN", ""),
            },
        },
    )


@mcp.tool()
def open(description: Optional[str] = None, safe_do_mask: Optional[int] = None) -> dict[str, Any]:
    """Bind AI/DI/DO controllers. Does not write DO until safe_state/set_level."""
    global _open, _active_safe_do_mask
    if _open:
        return err("Already open", reachable=True)
    desc = description or _default_desc()
    mask = _safe_mask() if safe_do_mask is None else int(safe_do_mask) & 0xFFFF
    try:
        resp = _wrap(sdk.call({"cmd": "open", "description": desc, "safe_do_mask": mask}))
        if resp.get("ok"):
            _open = True
            _active_safe_do_mask = mask
        return resp
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def close() -> dict[str, Any]:
    """Apply safe DO mask then release. ACTUATES DO."""
    global _open
    try:
        resp = _wrap(sdk.call({"cmd": "close"}))
        _open = False
        return resp
    except sdk.SdkError as exc:
        _open = False
        return err(str(exc), reachable=False)


@mcp.tool()
def probe_features() -> dict[str, Any]:
    """Read AI features: channel counts, connection types, value ranges."""
    try:
        return _wrap(sdk.call({"cmd": "probe_features"}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def configure_ai(channel: int, signal_type: int = 0, value_range: int = 1) -> dict[str, Any]:
    """Configure one AI channel before reading. signal_type 0=SE 1=Diff; value_range is enum."""
    if channel < 0 or channel > 15:
        return err("channel must be 0..15", reachable=True)
    try:
        return _wrap(
            sdk.call(
                {
                    "cmd": "configure_ai",
                    "channel": channel,
                    "signal_type": signal_type,
                    "value_range": value_range,
                }
            )
        )
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def read_voltage(channel: int) -> dict[str, Any]:
    """Read one AI channel in volts. Requires prior configure_ai."""
    if channel < 0 or channel > 15:
        return err("channel must be 0..15", reachable=True)
    try:
        return _wrap(sdk.call({"cmd": "read_voltage", "channel": channel}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def read_bit(channel: int, kind: str = "DI") -> dict[str, Any]:
    """Read DI or DO bit (0..15)."""
    if channel < 0 or channel > 15:
        return err("channel must be 0..15", reachable=True)
    if kind.upper() not in ("DI", "DO"):
        return err("kind must be DI or DO", reachable=True)
    try:
        return _wrap(sdk.call({"cmd": "read_bit", "channel": channel, "kind": kind.upper()}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def set_level(channel: int, level: bool) -> dict[str, Any]:
    """Set one DO bit. ACTUATES digital output."""
    if channel < 0 or channel > 15:
        return err("channel must be 0..15", reachable=True)
    try:
        return _wrap(sdk.call({"cmd": "set_level", "channel": channel, "level": level}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def safe_state() -> dict[str, Any]:
    """Write DO to safe_do_mask and verify. ACTUATES."""
    try:
        return _wrap(sdk.call({"cmd": "safe_state"}))
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)


@mcp.tool()
def self_test(description: Optional[str] = None) -> dict[str, Any]:
    """Bind + read AI features. Never writes DO or samples for actuation."""
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
