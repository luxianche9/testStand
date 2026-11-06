"""Generic communication link: the PC's own COM port, a TCP client or server, or a UDP socket.

One instance is one link to the device under test. ``settings`` may name it, and then the link is
made when the device opens (a COM port that is missing or busy, or a TCP server that does not
answer, leaves the device offline until it can be made):

* ``{"link": "serial", "port": "COM3", "baudrate": 115200, "bytesize": 8, "parity": "N", "stopbits": 1}``
* ``{"link": "tcp_client", "host": "192.168.1.10", "port": 502}``
* ``{"link": "tcp_server", "port": 9000}`` (optionally ``"bind"``)
* ``{"link": "udp", "localPort": 9000, "host": "192.168.1.10", "port": 9001}``

Without them the tools make the link (``open_serial``, ``connect_tcp``, ``listen_tcp``,
``open_udp``). Everything sent and received is on the one byte stream ``link``: a protocol (ICD) bound
to it in testStand turns its frames into fields. A reader thread polls the link, appends RX and
calls ``idle()`` after every read; a TCP client that lost its server reconnects by itself.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Literal

from teststand_device_sdk import (
    INVALID_ARGUMENT,
    NOT_CONFIGURED,
    ByteStream,
    Check,
    Device,
    DeviceConfig,
    DeviceError,
    model,
    param,
    tool,
)
from teststand_device_sdk.serialport import list_ports

from .links import Link, LinkDown, SerialLink, TcpClientLink, TcpServerLink, UdpLink

log = logging.getLogger(__name__)

READ_CHUNK = 4096
POLL_S = 0.01
RECONNECT_S = 2.0
LINKS = ("serial", "tcp_client", "tcp_server", "udp")

LinkInfo = model("LinkInfo", link=(str, "serial, tcp_client, tcp_server, udp, or none."),
                 connected=(bool, "The link is made (a TCP server also needs a client to send)."),
                 address=(dict[str, Any], "Port and line settings, or host / ports and the current peer."),
                 label=(str, "Short description, e.g. 'COM3 115200 8N1'."))
LinkWrite = model("LinkWrite", bytes=(int, "Bytes the OS or driver accepted; does not prove the device got them."))
LinkRx = model("LinkRx", bytes=(int, "Returned byte count."),
               hex=(str, "Raw bytes as space-separated hex; authoritative."),
               text=(str, "UTF-8 with replacement characters for invalid bytes."),
               overflow=(bool, "Bytes after the last clear were evicted from the stream buffer.", False))
PortList = model("SerialPorts", ports=(list[dict[str, str]], "COM ports Windows has: {port, device}."))
SafeLink = model("SafeLink", flushed=(bool, "Pending serial TX was discarded; sockets have nothing to discard."))

Host = param(str, "IPv4 address or host name of the device.", min_length=1, max_length=253)
TcpPort = param(int, "TCP/UDP port number.", ge=1, le=65535)
Baudrate = param(int, "Bit/s.", ge=50, le=4_000_000)
ByteSize = param(Literal[5, 6, 7, 8], "Data bits.")
Parity = param(Literal["N", "O", "E", "M", "S"], "Parity: N none, O odd, E even, M mark, S space.")
StopBits = param(Literal[1, 1.5, 2], "Stop bits.")
ClearRx = param(bool, "Discard RX received so far before sending.")


class CommLink(Device):
    manufacturer = "testStand"
    model = "Serial/TCP/UDP link"
    prefix = "link"
    capabilities = ("serial", "tcp_client", "tcp_server", "udp")
    version = "1.0.0"
    isolation = "inproc"
    instructions = ("A link to a device under test over the PC's COM port, TCP or UDP. If link_status says no link, "
                    "make it with open_serial / connect_tcp / listen_tcp / open_udp. write_text / write_hex send; "
                    "TX, RX and marks are on stream 'link'; link_transact sends and waits for a reply; read_rx "
                    "returns RX since the last clear.")
    description = ("A communication link of this PC: a COM port (built-in, USB-serial or a serial card's virtual "
                   "port), a TCP client or server, or a UDP socket. Its one byte stream 'link' carries every byte "
                   "sent and received and marks for connections; bind a protocol (ICD) to it to get fields.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        self.settings = dict(config.settings)
        kind = self.settings.get("link")
        if kind is not None and kind not in LINKS:
            raise ValueError(f"settings.link must be one of {', '.join(LINKS)}")
        self.rx_buffer_bytes = int(self.settings.get("rxBufferBytes", 1 << 20))
        self.link: Link | None = None
        self.rx_cursor = 0
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        self._next_reconnect = 0.0
        self.stream = self.streams.add(ByteStream("link", writer=self._send, max_bytes=self.rx_buffer_bytes,
                                                  label=_settings_label(self.settings)))

    # --- lifecycle ----------------------------------------------------
    def open(self) -> dict[str, Any]:
        self.rx_cursor = self.stream.buffer.head
        if self.settings.get("link"):
            self._make(self._from_settings())
        else:
            self.stream.set_state("not_configured")
        self._stop.clear()
        self._reader = threading.Thread(target=self._read_loop, name="link-rx", daemon=True)
        self._reader.start()
        return self._info()

    def close(self) -> dict[str, Any]:
        self._stop.set()
        if self._reader is not None:
            self._reader.join(timeout=2)
            self._reader = None
        with self.io_lock:
            closed = self.link is not None
            self._drop()
        self.stream.set_state("closed")
        return {"closed": closed}

    def _from_settings(self) -> Link:
        s = self.settings
        kind = s["link"]
        try:
            if kind == "serial":
                if not s.get("port"):
                    raise ValueError("settings.port (e.g. COM3) is required for a serial link")
                return self._serial(str(s["port"]), int(s.get("baudrate", 9600)), int(s.get("bytesize", 8)),
                                    str(s.get("parity", "N")), float(s.get("stopbits", 1)))
            if kind == "tcp_client":
                return TcpClientLink(str(s["host"]), int(s["port"]))
            if kind == "tcp_server":
                return TcpServerLink(int(s["port"]), str(s.get("bind", "0.0.0.0")))
            return UdpLink(int(s.get("localPort", 0)), str(s.get("host", "")), int(s.get("port", 0)))
        except (KeyError, ValueError) as exc:
            raise DeviceError(f"settings for a {kind} link are incomplete: {exc}", category=NOT_CONFIGURED) from exc

    def _serial(self, port: str, baudrate: int, bytesize: int, parity: str, stopbits: float) -> SerialLink:
        return SerialLink(port, baudrate=baudrate, bytesize=bytesize, parity=parity, stopbits=stopbits,
                          simulated=self.dry_run)

    def _make(self, link: Link) -> None:
        """Replace the current link (caller may hold io_lock)."""
        with self.io_lock:
            self._drop()
            self.link = link
        self.stream.mark(f"connect {link.label()}")
        self.stream.set_state("live")

    def _drop(self) -> None:
        if self.link is not None:
            self.link.close()
            self.link = None

    # --- receive path -------------------------------------------------
    def _drain(self) -> None:
        """Move what has arrived into the stream; caller holds io_lock. The empty read is a read return."""
        link = self.link
        if link is None:
            self.stream.idle()
            return
        while True:
            data = link.read(READ_CHUNK)
            for note in link.notes():
                self.stream.mark(note)
            if not data:
                self.stream.idle()
                return
            self.stream.rx(data)

    def _read_loop(self) -> None:
        while not self._stop.wait(POLL_S):
            try:
                with self.io_lock:
                    self._drain()
            except LinkDown as exc:
                self.stream.mark(f"disconnected: {exc}")
                self.stream.set_state("error", {"category": "device_unreachable", "message": str(exc)})
                self._next_reconnect = time.monotonic() + RECONNECT_S
                self.stream.idle()
            except Exception as exc:  # noqa: BLE001 - keep polling
                log.warning("link read failed: %s", exc)
                self.stream.set_state("error", {"category": "device_error", "message": str(exc)})
                self.stream.idle()
            self._reconnect()

    def _reconnect(self) -> None:
        """A TCP client whose server went away tries again every few seconds."""
        link = self.link
        if not isinstance(link, TcpClientLink) or link.sock is not None or time.monotonic() < self._next_reconnect:
            return
        self._next_reconnect = time.monotonic() + RECONNECT_S
        try:
            with self.io_lock:
                link.reconnect()
        except DeviceError as exc:
            log.info("reconnect failed: %s", exc)
            return
        self.stream.mark(f"reconnected {link.label()}")
        self.stream.set_state("live")

    def _received(self) -> tuple[bytes, bool]:
        buffer = self.stream.buffer
        cursor, head, chunks, overflow = self.rx_cursor, buffer.head, [], False
        while cursor < head:
            result = buffer.read(cursor, READ_CHUNK)
            overflow = overflow or result.dropped is not None
            chunks.extend(bytes.fromhex(record["data"]) for record in result.records if record["dir"] == "rx")
            if not result.records:
                break
            cursor = result.next
        return b"".join(chunks), overflow

    # --- send path ----------------------------------------------------
    def _send(self, data: bytes) -> int:
        """The stream writer (also used by ``link_transact``): bytes the link accepted."""
        with self.io_lock:
            if self.link is None:
                raise DeviceError("No link yet: open_serial, connect_tcp, listen_tcp or open_udp first",
                                  category=NOT_CONFIGURED)
            return self.link.write(data)

    def _write(self, data: bytes, clear_rx: bool) -> dict[str, Any]:
        with self.io_lock:
            if clear_rx:
                self._clear()
            sent = self.stream.send(data)
        return {"bytes": sent}

    def _clear(self) -> None:
        if self.link is not None:
            self.link.flush(rx=True, tx=False)
        self.rx_cursor = self.stream.mark("clear_rx")["seq"] + 1

    def _info(self) -> dict[str, Any]:
        link = self.link
        if link is None:
            return {"link": "none", "connected": False, "address": {}, "label": "未连接"}
        address = link.info()
        connected = address.get("connected", True) is not False
        return {"link": link.kind, "connected": connected, "address": address, "label": link.label()}

    # --- tools: make the link ----------------------------------------
    @tool(kind="configure", output=LinkInfo, effects=("link_connected",),
          description="Open a COM port of this PC (built-in, USB-serial, a serial card's virtual port) with its line "
                      "settings, replacing any current link. Sends nothing. A missing or busy port fails with the "
                      "reason; list_serial_ports shows what Windows has.")
    def open_serial(self, port: param(str, "COM port name, e.g. COM3.", pattern=r"^(?i:COM)[1-9][0-9]{0,2}$"),
                    baudrate: Baudrate = 115200, bytesize: ByteSize = 8, parity: Parity = "N",
                    stopbits: StopBits = 1) -> dict[str, Any]:
        self._make(self._serial(port, baudrate, bytesize, parity, float(stopbits)))
        return self._info()

    @tool(kind="configure", output=LinkInfo, effects=("link_connected",),
          description="Connect to a device that listens on TCP, replacing any current link. If the connection drops "
                      "later the link reconnects by itself every 2 s. Sends nothing.")
    def connect_tcp(self, host: Host, port: TcpPort) -> dict[str, Any]:
        self._make(TcpClientLink(host, port))
        return self._info()

    @tool(kind="configure", output=LinkInfo, effects=("link_connected",),
          description="Listen on a TCP port for the device to connect (one client; a new one replaces the old), "
                      "replacing any current link. Client connections and disconnections are marks on the stream; "
                      "sending fails until a client is connected.")
    def listen_tcp(self, port: TcpPort, bind: param(str, "Local address to listen on; 0.0.0.0 is every interface.",
                                                   max_length=64) = "0.0.0.0") -> dict[str, Any]:
        self._make(TcpServerLink(port, bind))
        return self._info()

    @tool(kind="configure", output=LinkInfo, effects=("link_connected",),
          description="Open a UDP socket on local_port (0: any free port), replacing any current link. Datagrams "
                      "from any sender are received; sends go to host:port, or to the last sender when they are "
                      "not given.")
    def open_udp(self, local_port: param(int, "Local UDP port to receive on; 0 picks a free one.", ge=0, le=65535) = 0,
                 host: param(str, "Destination address; empty: reply to the last sender.", max_length=253) = "",
                 port: param(int, "Destination port; 0: reply to the last sender.", ge=0, le=65535) = 0
                 ) -> dict[str, Any]:
        if bool(host) != bool(port):
            raise DeviceError("give both host and port, or neither", category=INVALID_ARGUMENT)
        self._make(UdpLink(local_port, host, port))
        return self._info()

    @tool(kind="configure", output=LinkInfo,
          description="Close the current link (COM port or socket) so the device is free for another program. "
                      "Sends nothing; the stream keeps everything received and gets a disconnect mark.")
    def disconnect(self) -> dict[str, Any]:
        with self.io_lock:
            had = self.link is not None
            self._drop()
        if had:
            self.stream.mark("disconnect")
        self.stream.set_state("not_configured")
        return self._info()

    # --- tools: traffic -----------------------------------------------
    @tool(kind="actuate", output=LinkWrite, safety_action="safe_state", effects=("link_tx",),
          description="Send text encoded as UTF-8; no newline is added (put \\r\\n in the text when the device "
                      "needs it). clear_rx first discards RX received so far. The count is what the link accepted, "
                      "not proof of receipt; do not resend automatically after a timeout.")
    def write_text(self, text: param(str, "Text to send.", max_length=65536), clear_rx: ClearRx = False
                   ) -> dict[str, Any]:
        return self._write(text.encode("utf-8"), clear_rx)

    @tool(kind="actuate", output=LinkWrite, safety_action="safe_state", effects=("link_tx",),
          description="Send exact bytes given as hexadecimal (spaces allowed), for binary protocols. clear_rx first "
                      "discards RX received so far. The count is what the link accepted.")
    def write_hex(self, hex: param(str, "Bytes as hex, e.g. 'AA 55 01 00'.", max_length=131072),
                  clear_rx: ClearRx = False) -> dict[str, Any]:
        try:
            data = bytes.fromhex(hex)
        except ValueError as exc:
            raise DeviceError(f"invalid hex: {exc}", category=INVALID_ARGUMENT) from exc
        return self._write(data, clear_rx)

    @tool(kind="read", output=LinkRx, evidence="measurement",
          description="Return bytes received since the last clear, without consuming them (the stream keeps them "
                      "too). max_bytes returns only the first bytes.")
    def read_rx(self, max_bytes: param(int, "Return at most this many bytes.", ge=1, le=1 << 20) = 4096
                ) -> dict[str, Any]:
        with self.io_lock:
            try:
                self._drain()
            except LinkDown:
                pass  # the reader thread reports it
            data, overflow = self._received()
        data = data[:max_bytes]
        return {"bytes": len(data), "hex": data.hex(" "), "text": data.decode("utf-8", errors="replace"),
                "overflow": overflow}

    @tool(kind="configure", output=LinkInfo,
          description="Discard RX received so far (serial driver buffer and read_rx accumulation); leaves a clear_rx "
                      "mark on the stream. Sends nothing.")
    def clear_rx(self) -> dict[str, Any]:
        with self.io_lock:
            self._clear()
        return self._info()

    @tool(kind="read", output=LinkInfo, evidence="controller_state",
          description="Which link is made: kind, port and line settings or host / ports, the TCP server's current "
                      "client, the UDP last sender. 'connected' says the port or socket is open, not that the device "
                      "answers.")
    def link_status(self) -> dict[str, Any]:
        with self.io_lock:
            return self._info()

    @tool(kind="read", output=PortList, evidence="controller_state",
          description="COM ports Windows has now (built-in, USB-serial, virtual), to pick one for open_serial.")
    def list_serial_ports(self) -> dict[str, Any]:
        ports = [{"port": "COM1", "device": "simulated"}] if self.dry_run else list_ports()
        return {"ports": ports}

    @tool(kind="safe", output=SafeLink,
          description="Discard pending serial TX so nothing further is sent. Sends no bytes and keeps the link "
                      "open; a link has no energized output to release, and the device may be mid-transaction.")
    def safe_state(self) -> dict[str, Any]:
        with self.io_lock:
            link = self.link
            if isinstance(link, SerialLink):
                link.flush(rx=False, tx=True)
                return {"flushed": True}
        return {"flushed": False}

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        info = self._info()
        configured = bool(self.settings.get("link")) or self.link is not None
        return [
            Check("链路已配置", configured, info["link"], "serial / tcp_client / tcp_server / udp",
                  "在设备设置里写 link 等参数，或调用 open_serial / connect_tcp / listen_tcp / open_udp"),
            Check("链路已建立", bool(info["connected"]), info["label"], "已连接",
                  "串口：端口存在且未被占用；TCP：对方在监听；不发送任何数据"),
        ]

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"links": list(LINKS), "configured": self.settings.get("link"), "rxBufferBytes": self.rx_buffer_bytes,
                "pollMs": POLL_S * 1000, "reconnectS": RECONNECT_S}


def _settings_label(settings: dict[str, Any]) -> str:
    kind = settings.get("link")
    if kind == "serial":
        return f"{str(settings.get('port', 'COM?')).upper()} {settings.get('baudrate', 9600)}"
    if kind == "tcp_client":
        return f"TCP {settings.get('host', '?')}:{settings.get('port', '?')}"
    if kind == "tcp_server":
        return f"TCP 监听 {settings.get('port', '?')}"
    if kind == "udp":
        return f"UDP {settings.get('localPort', 0)}"
    return "通信链路"
