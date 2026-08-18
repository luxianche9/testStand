"""MCP stdio server for ADLINK PCI-6208V (8-ch analog voltage output)."""

from __future__ import annotations

import atexit
import logging
import os
import sys
from typing import Any, Optional

from mcp.server.mcpserver import MCPServer

from testforge_remote import pci6208v_sdk as sdk
from testforge_remote.pci6208v_safety import clamp_volts, env_safe_volts, require_open, safe_state_impl, validate_channel
from testforge_remote.pci6208v_state import CHANNEL_COUNT, STATE, VOLT_MAX, VOLT_MIN
from testforge_remote.result import err, ok

# Logging MUST go to stderr — stdout is the MCP JSON-RPC pipe.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("adlink_pci6208v")

mcp = MCPServer(
    name="adlink-pci6208v",
    version="0.1.0",
    instructions=(
        "ADLINK PCI-6208V: 8-channel ±10 V analog output. "
        "open before write; close runs safe_state (default 0 V). "
        "self_test never actuates. read_last returns last written value only "
        "(no hardware readback)."
    ),
)


def _default_card_index() -> int:
    raw = os.environ.get("ADLINK_CARD_INDEX", "0")
    try:
        return int(raw)
    except ValueError:
        return 0


@mcp.tool()
def info() -> dict[str, Any]:
    """Board identity, SDK path, open state, and env defaults (no hardware access)."""
    return ok(
        "ADLINK PCI-6208V MCP",
        data={
            "board": "PCI-6208V",
            "channels": CHANNEL_COUNT,
            "range_v": [VOLT_MIN, VOLT_MAX],
            "dll": str(sdk.resolve_dll_path()) if sdk.resolve_dll_path() else None,
            "dry_run": sdk.dry_run(),
            "open": STATE.open,
            "card_index": STATE.card_index if STATE.open else _default_card_index(),
            "handle": STATE.handle,
            "safe_volts": STATE.safe_volts if STATE.open else env_safe_volts(),
            "env": {
                "PCIS_DASK_DLL": os.environ.get("PCIS_DASK_DLL"),
                "ADLINK_CARD_INDEX": os.environ.get("ADLINK_CARD_INDEX", "0"),
                "ADLINK_SAFE_VOLTS": os.environ.get("ADLINK_SAFE_VOLTS", "0.0"),
                "HARDWARE_DRY_RUN": os.environ.get("HARDWARE_DRY_RUN", ""),
            },
        },
    )


@mcp.tool()
def probe_cards(max_index: int = 4) -> dict[str, Any]:
    """Scan card indices with Register_Card/Release_Card. Does NOT write any voltage."""
    if max_index < 1 or max_index > 32:
        return err("max_index must be 1..32", reachable=False)

    if sdk.dry_run():
        return ok(
            "DRY_RUN probe",
            data={"cards": [{"card_index": 0, "handle": 0, "note": "simulated"}], "found": 1},
        )

    try:
        sdk.load_dll()
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)

    cards = []
    found = 0
    for idx in range(max_index):
        rc = sdk.register_card(sdk.PCI_6208V, idx)
        if rc < 0:
            cards.append(
                {
                    "card_index": idx,
                    "result": rc,
                    "note": "no card at this index" if rc == sdk.ERROR_NO_CARD else "vendor error",
                }
            )
            continue
        found += 1
        cards.append({"card_index": idx, "result": rc, "handle": rc, "note": "registered"})
        sdk.release_card(rc)

    if found == 0:
        return err(
            "No PCI-6208V answered. Is PCIS-DASK installed and the card seated?",
            reachable=False,
            data={"cards": cards, "found": 0},
        )
    return ok(f"{found} card(s) registered", data={"cards": cards, "found": found})


@mcp.tool()
def open(card_index: Optional[int] = None, safe_volts: Optional[float] = None) -> dict[str, Any]:
    """Register the card. Does not write outputs. safe_volts is used by safe_state/close."""
    if STATE.open:
        return err(f"Already open (handle={STATE.handle}, index={STATE.card_index})", reachable=True)

    idx = _default_card_index() if card_index is None else int(card_index)
    if idx < 0:
        return err("card_index must be >= 0", reachable=False)

    sv = env_safe_volts() if safe_volts is None else clamp_volts(float(safe_volts))
    if safe_volts is not None and (safe_volts < VOLT_MIN or safe_volts > VOLT_MAX):
        return err(
            f"safe_volts {safe_volts} outside [{VOLT_MIN}, {VOLT_MAX}] V — refused before Register_Card",
            reachable=False,
        )

    if sdk.dry_run():
        STATE.open = True
        STATE.card_index = idx
        STATE.handle = 0
        STATE.safe_volts = sv
        STATE.last_volts = [None] * CHANNEL_COUNT
        return ok("DRY_RUN open", data={"card_index": idx, "handle": 0, "safe_volts": sv})

    try:
        sdk.load_dll()
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)

    rc = sdk.register_card(sdk.PCI_6208V, idx)
    if rc < 0:
        return err(
            f"Register_Card(PCI_6208V, {idx}) failed with {rc}",
            reachable=False,
            data={"result": rc},
        )

    STATE.open = True
    STATE.card_index = idx
    STATE.handle = rc
    STATE.safe_volts = sv
    STATE.last_volts = [None] * CHANNEL_COUNT
    return ok(
        f"Registered card_index={idx} handle={rc}",
        data={"card_index": idx, "handle": rc, "safe_volts": sv},
    )


@mcp.tool()
def close() -> dict[str, Any]:
    """safe_state then Release_Card. Actuates: drives all channels to safe_volts."""
    if not STATE.open or STATE.handle is None:
        return ok("Already closed", data={"open": False})

    safe = safe_state_impl()
    handle = STATE.handle
    if not sdk.dry_run():
        try:
            sdk.release_card(handle)
        except sdk.SdkError as exc:
            log.warning("Release_Card failed: %s", exc)

    STATE.open = False
    STATE.handle = None
    STATE.last_volts = [None] * CHANNEL_COUNT
    return ok(
        "Closed after safe_state",
        data={"safe_state": safe, "released_handle": handle},
    )


@mcp.tool()
def set_voltage(channel: int, volts: float) -> dict[str, Any]:
    """Write one AO channel. ACTUATES real voltage. Clamped to ±10 V before SDK call."""
    gate = require_open()
    if gate is not None:
        return gate

    msg = validate_channel(channel)
    if msg:
        return err(msg, reachable=True)

    if volts < VOLT_MIN or volts > VOLT_MAX:
        return err(
            f"volts {volts} outside [{VOLT_MIN}, {VOLT_MAX}] V — refused (no clamp-and-write; fix the value)",
            reachable=True,
        )

    v = float(volts)
    if sdk.dry_run():
        STATE.last_volts[channel] = v
        return ok(f"DRY_RUN AO{channel}={v} V", data={"channel": channel, "volts": v})

    rc = sdk.ao_vwrite_channel(STATE.handle, channel, v)
    if rc != 0:
        return err(f"AO_VWriteChannel failed rc={rc}", reachable=True, data={"rc": rc})

    STATE.last_volts[channel] = v
    return ok(
        f"AO{channel} set to {v} V (actuates=true)",
        data={"channel": channel, "volts": v},
    )


@mcp.tool()
def read_last(channel: int) -> dict[str, Any]:
    """Return last value written this open session. No hardware readback on this board."""
    gate = require_open()
    if gate is not None:
        return gate

    msg = validate_channel(channel)
    if msg:
        return err(msg, reachable=True)

    last = STATE.last_volts[channel]
    if last is None:
        return err(
            f"AO{channel} never written this session. Manual says power-on is 0 V, "
            "but that is inference not measurement — refusing to invent a reading.",
            reachable=True,
            data={"channel": channel, "last_volts": None},
        )
    return ok(
        f"AO{channel} last written {last} V (software shadow, not ADC readback)",
        data={"channel": channel, "volts": last},
    )


@mcp.tool()
def safe_state() -> dict[str, Any]:
    """Drive all 8 channels to safe_volts. ACTUATES real voltage."""
    return safe_state_impl()


@mcp.tool()
def self_test() -> dict[str, Any]:
    """Register card and run AO_VoltScale (pure scale). Never writes DAC output."""
    idx = STATE.card_index if STATE.open else _default_card_index()

    if sdk.dry_run():
        return ok("DRY_RUN self_test passed", data={"card_index": idx, "scale_rc": 0, "bin": 0})

    try:
        sdk.load_dll()
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)

    owned = False
    handle = STATE.handle
    if handle is None:
        rc = sdk.register_card(sdk.PCI_6208V, idx)
        if rc < 0:
            return err(f"Register_Card failed rc={rc}", reachable=False, data={"rc": rc})
        handle = rc
        owned = True

    try:
        scale_rc, bin_val = sdk.ao_volt_scale(handle, 0, 0.0)
        if scale_rc != 0:
            return err(
                f"AO_VoltScale failed rc={scale_rc}",
                reachable=True,
                data={"rc": scale_rc},
            )
        return ok(
            "self_test ok (AO_VoltScale only — no DAC write)",
            data={"card_index": idx, "handle": handle, "scale_rc": scale_rc, "bin": bin_val},
        )
    finally:
        if owned and handle is not None:
            sdk.release_card(handle)


def _atexit_close() -> None:
    if STATE.open:
        try:
            close()
        except Exception as exc:  # noqa: BLE001 — best effort on exit
            log.warning("atexit close failed: %s", exc)


atexit.register(_atexit_close)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
