"""Moxa CP-118U-I: 8 isolated serial ports P1..P8 via PComm.

A reader thread polls every configured port and appends RX chunks to the
``serial<N>`` byte streams; every transmit goes through ``stream.send`` so
the accepted TX bytes land on the same stream, and configure/clear/flush
leave ``mark`` records. Those streams are the single traffic record:
``read_rx`` concatenates the RX chunks after a per-channel clear cursor and
never consumes them, so the run monitor and test steps see the same bytes.
Every read return (an empty ``sio_read``) calls ``stream.idle()``, so a
stream's watermark says "nothing more arrived up to here" within one poll
interval; unconfigured ports are confirmed idle on every poll as well.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Literal

from hardwareharness_device_sdk import (
    DEVICE_UNREACHABLE,
    INVALID_ARGUMENT,
    NOT_CONFIGURED,
    ByteStream,
    Device,
    DeviceError,
    Pinout,
    DeviceConfig,
    model,
    param,
    tool,
)

from .driver import BAUD_CODES, FLUSH_CODES, FLUSH_RX, FLUSH_TX, MAXDWORD, SIO_OK, SIO_RTS_BY_HW, PComm, PCommBackend
from .driver import build_mode, frame
from .pinout import pinout as build_pinout
from .sim import SimulatedPComm

log = logging.getLogger("hh_adapter_cp118u_i")

MAX_CHANNELS = 8
READ_CHUNK = 4096
MAX_POLL_SECONDS = 0.1
"""Upper bound on ``rxPollMs``: idle() must confirm the watermark at least every 200 ms."""

SerialConfig = model("SerialConfiguration", channel=(int, "P1..P8."), port=(int, "PComm/Windows COM number."),
                     baud=(int, "Bits per second."),
                     mode=(int, "PComm UART frame-format bits, NEVER RS-232/422/485 DIP setting."),
                     flow=(int, "PComm flow-control mask."), flow_rc=(int, "PComm flow-control return code.", None))
SerialWrite = model("SerialWrite", channel=(int, "P1..P8."),
                    bytes=(int, "Bytes accepted by the driver; may be short, does not prove peer receipt."))
SerialRx = model("SerialRx", channel=(int, "P1..P8."), bytes=(int, "Returned byte count, may be limited by max_bytes."),
                 hex=(str, "Exact raw bytes as space-separated hexadecimal; authoritative decoding evidence."),
                 text=(str, "UTF-8 with replacement for invalid bytes; replacement characters are not valid protocol "
                            "data."),
                 overflow=(bool, "true when bytes received after the last clear were evicted from the receive buffer; "
                                 "the returned prefix then does not start at the first byte received.", False))
Channel = model("ChannelResult", channel=(int, "Channel index using the tool's advertised origin."))
SerialFlush = model("SerialFlush", channel=(int, "P1..P8."), what=(str, "FIFO selection rx/tx/both."))
SerialStatus = model("SerialStatus", channel=(int, "P1..P8."), port=(int, "PComm/Windows COM number."),
                     baud=(int, "Configured bits per second."), frame=(str, "UART frame string, e.g. 8N1."),
                     mode=(int, "UART frame bits; not physical electrical mode.", None),
                     flow=(int, "PComm flow-control mask."),
                     lstatus=(int, "Raw driver modem/line status flags; no cable continuity proof."))
SafeSerial = model("SafeSerialResult",
                   tx_flushed=(list[int], "Channels whose pending TX FIFO was discarded; nothing was transmitted."))

SerialChannel = param(int, "Logical P1..P8 (one-based); COM mapping is in get_hardware_info.", ge=1, le=MAX_CHANNELS)
Baud = param(Literal[50, 75, 110, 134, 150, 300, 600, 1200, 1800, 2400, 4800, 7200, 9600, 19200, 38400, 57600,
                     115200, 230400, 460800, 921600], "UART bits per second; exact supported PComm rates.")
DataBits = param(Literal[5, 6, 7, 8], "UART data bits per frame.")
Parity = param(str, "N=none, O=odd, E=even, M=mark, S=space; case-insensitive.", pattern="^[NOEMSnoems]$")
StopBits = param(Literal[1, 2], "UART stop-bit setting, 1 or 2.")
Flow = param(int, "PComm flow-control bitmask passed to sio_flowctrl; 0 disables flow. Hardware flow can own RTS; "
                  "does not change the RS-485 DIP setting.", ge=0)
Text = param(str, "UTF-8 payload, sent exactly with no added terminator.")
HexData = param(str, "Even hexadecimal digits, whitespace allowed; exact raw bytes, e.g. 01 03 00 00.")
ClearRx = param(bool, "Discard software accumulation and hardware RX before transmitting; false preserves evidence.")
TimeoutMs = param(int, "Receive collection window in ms; 0 is immediate, positive empty window returns existing error "
                       "semantics.", ge=0, le=60000)
MaxBytes = param(int, "Maximum bytes from the oldest accumulated prefix; cache is not consumed. 0 preserves legacy "
                      "unlimited output.", ge=0, le=1048576)
What = param(str, "FIFO selection: rx, tx, both (case-insensitive). TX discards pending transmission.",
             pattern="^(?i:rx|tx|both)$")


MXSER_ENUM = r"SYSTEM\CurrentControlSet\Enum\MXSER"


def registry_ports(count: int) -> list[int] | None:
    """COM numbers Windows assigned to board 0 ports P1..Pn (``MXSERB00P00k``), or None if unavailable.

    Moxa does not number the ports consecutively: P3 can be COM8 while COM5 is P6.
    """
    try:
        import winreg
    except ImportError:
        return None
    ports: list[int] = []
    for index in range(count):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, rf"{MXSER_ENUM}\MXSERB00P{index:03d}") as key:
                with winreg.OpenKey(key, rf"{winreg.EnumKey(key, 0)}\Device Parameters") as params:
                    name = str(winreg.QueryValueEx(params, "PortName")[0])
            ports.append(int(name.upper().removeprefix("COM")))
        except (OSError, ValueError):
            return None
    return ports if len(set(ports)) == count else None


def configured_ports(settings: Any, discover: Any = registry_ports) -> list[int]:
    """P1..Pn -> PComm port numbers.

    ``portMap`` (or MOXA_PORT_MAP) wins, then an explicit ``basePort`` (or MOXA_BASE_PORT) + offset, then the
    Windows MXSER device registry, then COM3 + offset.
    """
    count = int(settings.get("portCount", os.environ.get("MOXA_PORT_COUNT") or MAX_CHANNELS))
    base_setting = settings.get("basePort", os.environ.get("MOXA_BASE_PORT"))
    base = int(base_setting or 3)
    if not 1 <= count <= MAX_CHANNELS or base < 1:
        raise ValueError(f"basePort >= 1 and portCount in 1..{MAX_CHANNELS} required")
    raw = settings.get("portMap", os.environ.get("MOXA_PORT_MAP", ""))
    if not raw:
        if not base_setting and (found := discover(count)):
            return found
        return [base + offset for offset in range(count)]
    try:
        ports = [int(part) for part in (raw.split(",") if isinstance(raw, str) else raw) if str(part).strip()]
    except ValueError as exc:
        raise ValueError("portMap must list PComm port numbers, e.g. 3,4,5,6,7,8,9,10") from exc
    if len(ports) != count or min(ports) < 1 or len(set(ports)) != count:
        raise ValueError("portMap must contain exactly portCount unique positive ports")
    return ports


class Cp118uI(Device):
    manufacturer = "Moxa"
    model = "CP-118U-I"
    prefix = "cp118u"
    capabilities = ("serial_rs232_rs422_rs485",)
    version = "0.2.0"
    instructions = ("Moxa CP-118U-I: 8 isolated serial ports as one card, channels P1..P8. configure_port before "
                    "traffic. RS-232/422/485 is DIP-switch only; software cannot change it. write_text/write_hex "
                    "actuate the line. All TX, RX and configuration marks are on streams serial1..serial8; "
                    "cp118u_transact sends and waits for a matching reply in one call.")
    description = ("Moxa CP-118U-I PCI Express card with 8 isolated serial ports P1..P8, reached through a fan-out "
                   "cable ending in 8 male DB9 connectors. Each port is RS-232, RS-422/4-wire RS-485 or 2-wire "
                   "RS-485 by an on-board DIP switch that software cannot read or change; the pinout lists all three "
                   "and activeMode is unknown. Streams serial1..serial8 carry the TX, RX and configuration marks.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.port_map = dict(enumerate(configured_ports(settings), start=1))
        self.poll_seconds = min(MAX_POLL_SECONDS, max(0.001, float(settings.get("rxPollMs", 10)) / 1000))
        self.rx_buffer_bytes = int(settings.get("rxBufferBytes", 1 << 20))
        self.pcomm: PCommBackend = self.select_driver(lambda: PComm(settings.get("dllPath")), SimulatedPComm)
        self.opened: list[int] = []
        self.configured: dict[int, dict[str, Any]] = {}
        self.rx_cursor: dict[int, int] = {}
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        for channel in self.port_map:
            self.streams.add(ByteStream(f"serial{channel}", writer=lambda data, ch=channel: self._send(ch, data),
                                        max_bytes=self.rx_buffer_bytes))

    def _stream(self, channel: int) -> ByteStream:
        stream = self.streams[f"serial{channel}"]
        assert isinstance(stream, ByteStream)
        return stream

    def _port(self, channel: int) -> int:
        port = self.port_map.get(channel)
        if port is None:
            raise DeviceError(f"channel must be 1..{len(self.port_map)}", category=INVALID_ARGUMENT)
        return port

    # --- lifecycle ----------------------------------------------------
    def open(self) -> Any:
        opened: list[int] = []
        with self.io_lock:
            for port in self.port_map.values():
                rc = self.pcomm.sio_open(port)
                if rc != SIO_OK:
                    for held in opened:
                        self.pcomm.sio_close(held)
                    raise DeviceError(f"sio_open({port}) failed rc={rc}; rolled back {len(opened)} port(s)",
                                      category=DEVICE_UNREACHABLE, details={"failed_port": port, "rc": rc})
                self.pcomm.sio_set_read_timeouts(port, MAXDWORD, 0)  # poll mode: sio_read returns immediately
                opened.append(port)
            self.opened = opened
            self.configured.clear()
            self.rx_cursor = {channel: self._stream(channel).buffer.head for channel in self.port_map}
        for channel in self.port_map:
            self._stream(channel).set_state("not_configured")
        self._stop.clear()
        self._reader = threading.Thread(target=self._read_loop, name="cp118u-rx", daemon=True)
        self._reader.start()
        return {"base_port": opened[0], "port_count": len(opened), "ports": opened}

    def close(self) -> Any:
        self._stop.set()
        if self._reader is not None:
            self._reader.join(timeout=2)
            self._reader = None
        closed: list[int] = []
        with self.io_lock:
            for port in self.opened:
                if self.pcomm.sio_close(port) == SIO_OK:
                    closed.append(port)
            self.opened = []
            self.configured.clear()
        for channel in self.port_map:
            self._stream(channel).set_state("closed")
        return {"closed_ports": closed}

    # --- receive path -------------------------------------------------
    def _drain(self, channel: int) -> None:
        """Move everything waiting in the port's RX FIFO into its stream; caller holds io_lock.

        The empty read that ends the drain is a read return: ``idle()`` confirms nothing more arrived.
        """
        port, stream = self.port_map[channel], self._stream(channel)
        while True:
            count, data = self.pcomm.sio_read(port, READ_CHUNK)
            if count <= 0 or not data:
                stream.idle()
                return
            stream.rx(data)

    def _read_loop(self) -> None:
        while not self._stop.wait(self.poll_seconds):
            for channel in self.port_map:
                if channel not in self.configured:
                    self._stream(channel).idle()  # not configured: nothing can arrive on the stream
                    continue
                try:
                    with self.io_lock:
                        self._drain(channel)
                    self._stream(channel).set_state("live")
                except Exception as exc:  # noqa: BLE001 - keep polling the other ports
                    log.warning("P%s read failed: %s", channel, exc)
                    self._stream(channel).set_state("error", {"category": "device_error", "message": str(exc)})

    def _clear_rx(self, channel: int) -> None:
        """Discard hardware RX and move the read_rx cursor past everything received; caller holds io_lock."""
        rc = self.pcomm.sio_flush(self.port_map[channel], FLUSH_RX)
        if rc != SIO_OK:
            raise DeviceError(f"sio_flush(rx) failed rc={rc}", details={"rc": rc})
        self.rx_cursor[channel] = self._stream(channel).mark("clear_rx")["seq"] + 1

    def _received(self, channel: int) -> tuple[bytes, bool]:
        buffer = self._stream(channel).buffer
        cursor, head, chunks, overflow = self.rx_cursor.get(channel, 0), buffer.head, [], False
        while cursor < head:
            result = buffer.read(cursor, READ_CHUNK)
            overflow = overflow or result.dropped is not None
            chunks.extend(bytes.fromhex(record["data"]) for record in result.records if record["dir"] == "rx")
            if not result.records:
                break
            cursor = result.next
        return b"".join(chunks), overflow

    def _send(self, channel: int, data: bytes) -> int:
        """The stream writer: returns the byte count the driver accepted. Also used by ``<prefix>_transact``."""
        port = self._port(channel)
        if channel not in self.configured:
            raise DeviceError(f"P{channel} is not configured; call configure_port first",
                              category=NOT_CONFIGURED, details={"channel": channel})
        with self.io_lock:
            rc = self.pcomm.sio_write(port, data)
        if rc < 0:
            raise DeviceError(f"sio_write failed rc={rc}", details={"rc": rc})
        return rc

    def _write(self, channel: int, data: bytes, clear_rx: bool) -> dict[str, Any]:
        self._port(channel)
        with self.io_lock:
            if clear_rx:
                self._clear_rx(channel)
            sent = self._stream(channel).send(data)
        return {"channel": channel, "bytes": sent}

    # --- tools --------------------------------------------------------
    @tool(kind="configure", output=SerialConfig, effects=("serial_port_configured",),
          description="Configure UART frame and flow on P1..P8 without sending payload. Returned mode encodes "
                      "data/parity/stop bits. RS-232/422/485 is a physical DIP-switch setting that software cannot "
                      "detect or change.")
    def configure_port(self, channel: SerialChannel, baud: Baud = 9600, data_bits: DataBits = 8, parity: Parity = "N",
                       stop_bits: StopBits = 1, flow: Flow = 0) -> Any:
        port = self._port(channel)
        mode = build_mode(data_bits, parity, stop_bits)
        with self.io_lock:
            rc = self.pcomm.sio_ioctl(port, BAUD_CODES[baud], mode)
            if rc != SIO_OK:
                raise DeviceError(f"sio_ioctl failed rc={rc}", details={"rc": rc})
            flow_rc = self.pcomm.sio_flowctrl(port, flow)
            if flow_rc not in (SIO_OK, SIO_RTS_BY_HW):
                raise DeviceError(f"sio_flowctrl failed rc={flow_rc}", details={"rc": flow_rc})
            self.configured[channel] = {"baud": baud, "frame": frame(mode), "flow": flow}
        stream = self._stream(channel)
        stream.mark(f"configure_port baud={baud} {frame(mode)} flow={flow}")
        stream.set_state("live")
        return {"channel": channel, "port": port, "baud": baud, "mode": mode, "flow": flow, "flow_rc": flow_rc}

    @tool(kind="actuate", output=SerialWrite, requires=("serial_port_configured",),
          description="Transmit text encoded as UTF-8 with no automatic newline. clear_rx optionally discards prior RX "
                      "evidence. Returned bytes counts driver acceptance, may be short, and does not prove peer "
                      "receipt; do not replay automatically after timeout.")
    def write_text(self, channel: SerialChannel, text: Text, clear_rx: ClearRx = False) -> Any:
        return self._write(channel, text.encode("utf-8"), clear_rx)

    @tool(kind="actuate", output=SerialWrite, requires=("serial_port_configured",),
          description="Transmit exact bytes from hexadecimal, with optional spaces. Use this for binary protocols or a "
                      "non-UTF-8 encoding. clear_rx discards prior RX; returned bytes is driver acceptance, not peer "
                      "receipt.")
    def write_hex(self, channel: SerialChannel, hex_data: HexData, clear_rx: ClearRx = False) -> Any:
        try:
            data = bytes.fromhex("".join(hex_data.split()))
        except ValueError as exc:
            raise DeviceError(f"invalid hex: {exc}", category=INVALID_ARGUMENT) from exc
        return self._write(channel, data, clear_rx)

    @tool(kind="read", output=SerialRx, requires=("serial_port_configured",), evidence="measurement",
          description="Return accumulated RX since the last clear/flush without consuming it; max_bytes returns the "
                      "oldest prefix. hex is exact; text is UTF-8 with replacement. timeout_ms=0 permits an empty "
                      "success; positive empty waits retain the existing device_error with empty data in "
                      "error.details. Repeated reads can contain the same bytes.")
    def read_rx(self, channel: SerialChannel, timeout_ms: TimeoutMs = 0, max_bytes: MaxBytes = 65536) -> Any:
        self._port(channel)
        if timeout_ms > 0:
            time.sleep(timeout_ms / 1000)  # the reader keeps collecting meanwhile
        with self.io_lock:
            if channel in self.configured:
                self._drain(channel)
            data, overflow = self._received(channel)
        if max_bytes > 0:
            data = data[:max_bytes]
        if not data and timeout_ms > 0:
            raise DeviceError(f"No data on P{channel} within {timeout_ms} ms (port open — peer silent)",
                              details={"channel": channel, "hex": "", "text": "", "bytes": 0})
        return {"channel": channel, "bytes": len(data), "hex": data.hex(" "),
                "text": data.decode("utf-8", errors="replace"), "overflow": overflow}

    @tool(kind="actuate", output=Channel, requires=("serial_port_configured",),
          description="Discard this channel's accumulated software RX and hardware RX FIFO. This permanently removes "
                      "receive evidence; the operation does not transmit or change the electrical mode.")
    def clear_rx(self, channel: SerialChannel) -> Any:
        self._port(channel)
        with self.io_lock:
            self._clear_rx(channel)
        return {"channel": channel}

    @tool(kind="actuate", output=SerialFlush, requires=("serial_port_configured",),
          description="Discard RX, pending TX, or both FIFOs. RX also clears software accumulation; TX can discard "
                      "pending transmissions. Capture needed evidence before flushing.")
    def flush(self, channel: SerialChannel, what: What = "both") -> Any:
        port = self._port(channel)
        selection = what.lower()
        with self.io_lock:
            rc = self.pcomm.sio_flush(port, FLUSH_CODES[selection])
            if rc != SIO_OK:
                raise DeviceError(f"sio_flush failed rc={rc}", details={"rc": rc})
            mark = self._stream(channel).mark(f"flush {selection}")
            if selection in ("rx", "both"):
                self.rx_cursor[channel] = mark["seq"] + 1
        return {"channel": channel, "what": what}

    @tool(kind="read", output=SerialStatus, requires=("serial_port_configured",),
          description="Read current UART baud/frame/flow and raw modem line flags. mode is a UART frame code, not an "
                      "RS-232/422/485 setting. Status flags cannot prove cable continuity, correct DIP switches, or "
                      "peer response.")
    def get_line_status(self, channel: SerialChannel) -> Any:
        port = self._port(channel)
        with self.io_lock:
            baud, mode = self.pcomm.sio_getbaud(port), self.pcomm.sio_getmode(port)
            flow, lstatus = self.pcomm.sio_getflow(port), self.pcomm.sio_lstatus(port)
        return {"channel": channel, "port": port, "baud": baud, "frame": frame(mode), "mode": mode, "flow": flow,
                "lstatus": lstatus}

    @tool(kind="safe", output=SafeSerial,
          description="Discard pending TX on every open port so nothing further is transmitted. Sends no bytes and "
                      "keeps RX evidence and UART settings. A serial line has no energized output to release; a peer "
                      "may still be mid-transaction.")
    def safe_state(self) -> Any:
        flushed: list[int] = []
        failures: list[dict[str, int]] = []
        with self.io_lock:
            for channel, port in self.port_map.items():
                if port not in self.opened:
                    continue
                rc = self.pcomm.sio_flush(port, FLUSH_TX)
                if rc == SIO_OK:
                    flushed.append(channel)
                else:
                    failures.append({"channel": channel, "rc": rc})
        if failures:
            raise DeviceError(f"safe_state incomplete: {len(failures)} port(s) failed",
                              details={"failures": failures, "tx_flushed": flushed})
        return {"tx_flushed": flushed}

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"channels": {"minimum": 1, "maximum": len(self.port_map)},
                "portMap": {str(channel): port for channel, port in self.port_map.items()},
                "physicalMode": "unknown", "modeSelection": "hardware_dip", "textEncoding": "utf-8",
                "rxSemantics": "accumulated_since_clear_nonconsuming_oldest_prefix",
                "rxBufferBytes": self.rx_buffer_bytes, "rxPollMs": round(self.poll_seconds * 1000, 3),
                "configuredChannels": sorted(self.configured)}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
