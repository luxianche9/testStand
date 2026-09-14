"""MCP stdio server for Moxa CP-118U-I (8-port serial)."""

from __future__ import annotations

import atexit
import logging
import os
import sys
import time
from typing import Any, Optional

from mcp.server.mcpserver import MCPServer

from hardwareharness_remote import cp118u_sdk as sdk
from hardwareharness_remote.cp118u_state import STATE
from hardwareharness_remote.result import err, ok

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("moxa_cp118u_i")

mcp = MCPServer(
    name="moxa-cp118u-i",
    version="0.1.0",
    instructions=(
        "Moxa CP-118U-I: 8 isolated serial ports as one card, channels P1..P8. "
        "base_port is PComm number for P1 (bench default 3 → COM3..COM10). "
        "RS-232/422/485 is DIP-switch only — software cannot change it. "
        "self_test never transmits. write_text/write_hex actuate the line."
    ),
)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _channel_to_port(channel: int) -> Optional[int]:
    """Board silkscreen P1..P8 → PComm port number."""
    if channel < 1 or channel > STATE.port_count:
        return None
    return STATE.port_map.get(channel)


def _configured_ports(base_port: int, port_count: int) -> list[int]:
    raw = os.environ.get("MOXA_PORT_MAP", "").strip()
    if raw:
        try:
            ports = [int(part.strip()) for part in raw.split(",") if part.strip()]
        except ValueError as exc:
            raise ValueError("MOXA_PORT_MAP must be a comma-separated list of port numbers") from exc
        if len(ports) != port_count or any(port < 1 for port in ports) or len(set(ports)) != len(ports):
            raise ValueError("MOXA_PORT_MAP must contain exactly port_count unique positive ports")
        return ports
    return [base_port + i for i in range(port_count)]


def _require_open():
    if not STATE.open:
        return err("Card not open. Call open first.", reachable=False)
    return None


def _drain_rx(port: int, channel: int) -> None:
    """Non-blocking read into accumulation buffer."""
    if sdk.dry_run():
        return
    sdk.sio_set_read_timeouts(port, sdk.MAXDWORD, 0)
    while True:
        n, data = sdk.sio_read(port, 4096)
        if n <= 0 or not data:
            break
        STATE.rx_buf.setdefault(channel, bytearray()).extend(data)


@mcp.tool()
def info() -> dict[str, Any]:
    """Board identity, DLL path, open state (no hardware access)."""
    return ok(
        "Moxa CP-118U-I MCP",
        data={
            "board": "CP-118U-I",
            "channels": "P1..P8",
            "dll": str(sdk.resolve_dll_path()) if sdk.resolve_dll_path() else None,
            "dry_run": sdk.dry_run(),
            "open": STATE.open,
            "base_port": STATE.base_port if STATE.open else _env_int("MOXA_BASE_PORT", 3),
            "port_count": STATE.port_count if STATE.open else _env_int("MOXA_PORT_COUNT", 8),
            "ports": list(STATE.ports),
            "port_map": dict(STATE.port_map),
            "env": {
                "PCOMM_DLL": os.environ.get("PCOMM_DLL"),
                "MOXA_BASE_PORT": os.environ.get("MOXA_BASE_PORT", "3"),
                "MOXA_PORT_COUNT": os.environ.get("MOXA_PORT_COUNT", "8"),
                "HARDWARE_DRY_RUN": os.environ.get("HARDWARE_DRY_RUN", ""),
            },
        },
    )


@mcp.tool()
def probe_ports(max_port: int = 16) -> dict[str, Any]:
    """Enumerate openable PComm ports (read-only: open/query/close). Does not send bytes."""
    if max_port < 1 or max_port > 256:
        return err("max_port must be 1..256", reachable=False)

    if sdk.dry_run():
        rows = [
            {"port": p, "com": f"COM{p}", "baud": 38400, "frame": "8N1", "flow": 0, "lstatus": 0x0B if p >= 3 else 0}
            for p in range(1, min(max_port, 10) + 1)
        ]
        return ok("DRY_RUN probe", data={"ports": rows, "found": len(rows)})

    try:
        sdk.load_dll()
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)

    rows = []
    for port in range(1, max_port + 1):
        if sdk.sio_open(port) != sdk.SIO_OK:
            continue
        try:
            baud = sdk.sio_getbaud(port)
            mode = sdk.sio_getmode(port)
            flow = sdk.sio_getflow(port)
            lstat = sdk.sio_lstatus(port)
            dec = sdk.decode_mode(mode)
            frame = f"{dec['data_bits']}{dec['parity']}{dec['stop_bits']}"
            note = "on-board COM (likely not Moxa)" if lstat == 0x00 else ""
            rows.append(
                {
                    "port": port,
                    "com": f"COM{port}",
                    "baud": baud,
                    "frame": frame,
                    "flow": flow,
                    "lstatus": lstat,
                    "note": note,
                }
            )
        finally:
            sdk.sio_close(port)

    if not rows:
        return err(
            "No serial port answered. Is the Moxa driver installed and the card seated?",
            reachable=False,
            data={"ports": [], "found": 0},
        )
    return ok(f"{len(rows)} port(s) opened", data={"ports": rows, "found": len(rows)})


@mcp.tool()
def open(base_port: Optional[int] = None, port_count: Optional[int] = None) -> dict[str, Any]:
    """Open all ports for one card (P1..Pport_count). Rolls back on any failure."""
    if STATE.open:
        return err(f"Already open base_port={STATE.base_port} ports={STATE.ports}", reachable=True)

    bp = _env_int("MOXA_BASE_PORT", 3) if base_port is None else int(base_port)
    pc = _env_int("MOXA_PORT_COUNT", 8) if port_count is None else int(port_count)
    if bp < 1 or pc < 1 or pc > 16:
        return err("base_port >= 1 and port_count in 1..16 required", reachable=False)

    try:
        ports = _configured_ports(bp, pc)
    except ValueError as exc:
        return err(str(exc), reachable=False)

    if sdk.dry_run():
        STATE.open = True
        STATE.base_port = bp
        STATE.port_count = pc
        STATE.ports = ports
        STATE.port_map = {channel: port for channel, port in enumerate(ports, start=1)}
        STATE.rx_buf = {ch: bytearray() for ch in range(1, pc + 1)}
        return ok("DRY_RUN open", data={"base_port": bp, "port_count": pc, "ports": ports})

    try:
        sdk.load_dll()
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)

    opened: list[int] = []
    for port in ports:
        rc = sdk.sio_open(port)
        if rc != sdk.SIO_OK:
            for p in opened:
                sdk.sio_close(p)
            return err(
                f"sio_open({port}) failed rc={rc}; rolled back {len(opened)} port(s)",
                reachable=False,
                data={"failed_port": port, "rc": rc},
            )
        # Poll mode for reads under our time budget
        sdk.sio_set_read_timeouts(port, sdk.MAXDWORD, 0)
        opened.append(port)

    STATE.open = True
    STATE.base_port = bp
    STATE.port_count = pc
    STATE.ports = opened
    STATE.port_map = {channel: port for channel, port in enumerate(opened, start=1)}
    STATE.rx_buf = {ch: bytearray() for ch in range(1, pc + 1)}
    return ok(
        f"Opened {pc} ports starting at PComm {bp} (P1..P{pc})",
        data={"base_port": bp, "port_count": pc, "ports": opened},
    )


@mcp.tool()
def close() -> dict[str, Any]:
    """Close all held ports. Does not change DIP wiring mode."""
    if not STATE.open:
        return ok("Already closed", data={"open": False})

    closed = []
    if not sdk.dry_run():
        for port in STATE.ports:
            try:
                sdk.sio_close(port)
                closed.append(port)
            except sdk.SdkError as exc:
                log.warning("sio_close(%s) failed: %s", port, exc)
    else:
        closed = list(STATE.ports)

    STATE.open = False
    STATE.ports = []
    STATE.port_map = {}
    STATE.rx_buf = {}
    return ok("Closed", data={"closed_ports": closed})


@mcp.tool()
def configure_port(
    channel: int,
    baud: int = 9600,
    data_bits: int = 8,
    parity: str = "N",
    stop_bits: int = 1,
    flow: int = 0,
) -> dict[str, Any]:
    """Configure one channel via sio_ioctl / sio_flowctrl. Does not transmit payload bytes."""
    gate = _require_open()
    if gate is not None:
        return gate

    port = _channel_to_port(channel)
    if port is None:
        return err(f"channel must be 1..{STATE.port_count}", reachable=True)

    code = sdk.baud_to_code(baud)
    if code is None:
        return err(f"unsupported baud {baud}; known: {sorted(sdk.BAUD_CODES)}", reachable=True)

    try:
        mode = sdk.build_mode(data_bits, parity, stop_bits)
    except ValueError as exc:
        return err(str(exc), reachable=True)

    if sdk.dry_run():
        return ok(
            f"DRY_RUN configure P{channel}",
            data={"channel": channel, "port": port, "baud": baud, "mode": mode, "flow": flow},
        )

    rc = sdk.sio_ioctl(port, code, mode)
    if rc != sdk.SIO_OK:
        return err(f"sio_ioctl failed rc={rc}", reachable=True, data={"rc": rc})
    frc = sdk.sio_flowctrl(port, flow)
    # SIO_RTS_BY_HW (-6) is OK when HW flow owns RTS
    if frc not in (sdk.SIO_OK, sdk.SIO_RTS_BY_HW):
        return err(f"sio_flowctrl failed rc={frc}", reachable=True, data={"rc": frc})

    return ok(
        f"P{channel} (PComm {port}) configured {baud} {data_bits}{parity.upper()}{stop_bits} flow={flow}",
        data={"channel": channel, "port": port, "baud": baud, "mode": mode, "flow": flow, "flow_rc": frc},
    )


@mcp.tool()
def write_text(channel: int, text: str, clear_rx: bool = False) -> dict[str, Any]:
    """Transmit UTF-8 text on channel. ACTUATES the serial line."""
    return _write_bytes(channel, text.encode("utf-8"), clear_rx, label="text")


@mcp.tool()
def write_hex(channel: int, hex_data: str, clear_rx: bool = False) -> dict[str, Any]:
    """Transmit raw bytes from hex string (spaces allowed). ACTUATES the serial line."""
    cleaned = "".join(hex_data.split())
    try:
        data = bytes.fromhex(cleaned)
    except ValueError as exc:
        return err(f"invalid hex: {exc}", reachable=True)
    return _write_bytes(channel, data, clear_rx, label="hex")


def _write_bytes(channel: int, data: bytes, clear_rx: bool, label: str) -> dict[str, Any]:
    gate = _require_open()
    if gate is not None:
        return gate
    port = _channel_to_port(channel)
    if port is None:
        return err(f"channel must be 1..{STATE.port_count}", reachable=True)

    if clear_rx:
        STATE.rx_buf[channel] = bytearray()
        if not sdk.dry_run():
            sdk.sio_flush(port, sdk.FLUSH_RX)

    if sdk.dry_run():
        return ok(
            f"DRY_RUN write {label} {len(data)} byte(s) on P{channel}",
            data={"channel": channel, "bytes": len(data)},
        )

    rc = sdk.sio_write(port, data)
    if rc < 0:
        return err(f"sio_write failed rc={rc}", reachable=True, data={"rc": rc})
    return ok(
        f"Wrote {rc} byte(s) on P{channel} (actuates=true)",
        data={"channel": channel, "bytes": rc},
    )


@mcp.tool()
def read_rx(channel: int, timeout_ms: int = 0, max_bytes: int = 65536) -> dict[str, Any]:
    """Return RX accumulated since last clear_rx (plus any new bytes within timeout_ms)."""
    gate = _require_open()
    if gate is not None:
        return gate
    port = _channel_to_port(channel)
    if port is None:
        return err(f"channel must be 1..{STATE.port_count}", reachable=True)

    deadline = time.monotonic() + max(0, timeout_ms) / 1000.0
    if not sdk.dry_run():
        while True:
            _drain_rx(port, channel)
            if time.monotonic() >= deadline:
                break
            time.sleep(0.01)

    buf = bytes(STATE.rx_buf.get(channel, b""))
    if max_bytes > 0:
        buf = buf[:max_bytes]
    if not buf and timeout_ms > 0:
        return err(
            f"No data on P{channel} within {timeout_ms} ms (port open — peer silent)",
            reachable=True,
            data={"channel": channel, "hex": "", "text": "", "bytes": 0},
        )
    return ok(
        f"P{channel} RX {len(buf)} byte(s)",
        data={
            "channel": channel,
            "bytes": len(buf),
            "hex": buf.hex(" "),
            "text": buf.decode("utf-8", errors="replace"),
        },
    )


@mcp.tool()
def clear_rx(channel: int) -> dict[str, Any]:
    """Clear software RX accumulation and hardware RX FIFO for one channel."""
    gate = _require_open()
    if gate is not None:
        return gate
    port = _channel_to_port(channel)
    if port is None:
        return err(f"channel must be 1..{STATE.port_count}", reachable=True)

    STATE.rx_buf[channel] = bytearray()
    if not sdk.dry_run():
        sdk.sio_flush(port, sdk.FLUSH_RX)
    return ok(f"P{channel} RX cleared", data={"channel": channel})


@mcp.tool()
def flush(channel: int, what: str = "both") -> dict[str, Any]:
    """Flush FIFO: what = rx | tx | both."""
    gate = _require_open()
    if gate is not None:
        return gate
    port = _channel_to_port(channel)
    if port is None:
        return err(f"channel must be 1..{STATE.port_count}", reachable=True)

    wmap = {"rx": sdk.FLUSH_RX, "tx": sdk.FLUSH_TX, "both": sdk.FLUSH_BOTH}
    code = wmap.get(what.lower())
    if code is None:
        return err("what must be rx, tx, or both", reachable=True)

    if what.lower() in ("rx", "both"):
        STATE.rx_buf[channel] = bytearray()

    if sdk.dry_run():
        return ok(f"DRY_RUN flush {what} P{channel}", data={"channel": channel, "what": what})

    rc = sdk.sio_flush(port, code)
    if rc != sdk.SIO_OK:
        return err(f"sio_flush failed rc={rc}", reachable=True, data={"rc": rc})
    return ok(f"P{channel} flushed {what}", data={"channel": channel, "what": what})


@mcp.tool()
def get_line_status(channel: int) -> dict[str, Any]:
    """Query baud/mode/flow/lstatus for one open channel."""
    gate = _require_open()
    if gate is not None:
        return gate
    port = _channel_to_port(channel)
    if port is None:
        return err(f"channel must be 1..{STATE.port_count}", reachable=True)

    if sdk.dry_run():
        return ok(
            "DRY_RUN status",
            data={"channel": channel, "port": port, "baud": 9600, "frame": "8N1", "flow": 0, "lstatus": 0},
        )

    baud = sdk.sio_getbaud(port)
    mode = sdk.sio_getmode(port)
    flow = sdk.sio_getflow(port)
    lstat = sdk.sio_lstatus(port)
    dec = sdk.decode_mode(mode)
    frame = f"{dec['data_bits']}{dec['parity']}{dec['stop_bits']}"
    return ok(
        f"P{channel} status",
        data={
            "channel": channel,
            "port": port,
            "baud": baud,
            "frame": frame,
            "mode": mode,
            "flow": flow,
            "lstatus": lstat,
        },
    )


@mcp.tool()
def self_test() -> dict[str, Any]:
    """Open each card port, query status, close. Never transmits."""
    bp = STATE.base_port if STATE.open else _env_int("MOXA_BASE_PORT", 3)
    pc = STATE.port_count if STATE.open else _env_int("MOXA_PORT_COUNT", 8)

    if sdk.dry_run():
        return ok("DRY_RUN self_test passed", data={"base_port": bp, "port_count": pc})

    try:
        sdk.load_dll()
    except sdk.SdkError as exc:
        return err(str(exc), reachable=False)

    # If already open, just query without re-open/close.
    if STATE.open:
        details = []
        for ch in range(1, pc + 1):
            port = _channel_to_port(ch)
            details.append(
                {
                    "channel": ch,
                    "port": port,
                    "baud": sdk.sio_getbaud(port),
                    "lstatus": sdk.sio_lstatus(port),
                }
            )
        return ok("self_test ok (already open)", data={"ports": details})

    failed = []
    ok_ports = []
    for i in range(pc):
        port = bp + i
        if sdk.sio_open(port) != sdk.SIO_OK:
            failed.append(port)
            continue
        try:
            ok_ports.append(
                {
                    "port": port,
                    "baud": sdk.sio_getbaud(port),
                    "lstatus": sdk.sio_lstatus(port),
                }
            )
        finally:
            sdk.sio_close(port)

    if failed:
        return err(
            f"self_test: could not open port(s) {failed}",
            reachable=False,
            data={"ok_ports": ok_ports, "failed": failed},
        )
    return ok("self_test ok (no bytes sent)", data={"ports": ok_ports})


def _atexit_close() -> None:
    if STATE.open:
        try:
            close()
        except Exception as exc:  # noqa: BLE001
            log.warning("atexit close failed: %s", exc)


atexit.register(_atexit_close)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
