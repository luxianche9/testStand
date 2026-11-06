"""The four kinds of link: the PC's COM port, a TCP client, a TCP server and a UDP socket.

Each has the same blocking, non-waiting interface the adapter's reader thread polls: ``read``
returns what has arrived (``b""`` when nothing has), ``write`` returns the bytes the OS accepted.
A connection that ended raises :class:`LinkDown` from ``read``; ``notes`` returns events worth a
``mark`` on the stream (a TCP client of the server connected or left). Sockets are non-blocking
and only touched by the caller under the device's ``io_lock``.
"""

from __future__ import annotations

import errno
import socket
from typing import Any, Protocol

from teststand_device_sdk import DEVICE_UNREACHABLE, INVALID_ARGUMENT, NOT_CONFIGURED, DeviceError
from teststand_device_sdk.serialport import SerialPort, SimulatedSerialPort

CONNECT_TIMEOUT_S = 3.0
_WOULD_BLOCK = (BlockingIOError, InterruptedError)


class LinkDown(Exception):
    """The connection ended; ``read`` and ``write`` fail until it is made again."""


class Link(Protocol):
    kind: str

    def read(self, max_bytes: int) -> bytes: ...
    def write(self, data: bytes) -> int: ...
    def flush(self, rx: bool, tx: bool) -> None: ...
    def notes(self) -> list[str]: ...
    def info(self) -> dict[str, Any]: ...
    def label(self) -> str: ...
    def close(self) -> None: ...


class SerialLink:
    """A Windows COM port (built-in, USB-serial or a multi-port card's virtual port)."""

    kind = "serial"

    def __init__(self, port: str, *, baudrate: int, bytesize: int, parity: str, stopbits: float,
                 simulated: bool = False) -> None:
        self.port = port.upper()
        self.settings = {"baudrate": baudrate, "bytesize": bytesize, "parity": parity.upper(), "stopbits": stopbits}
        self.backend: Any = SimulatedSerialPort(self.port, loopback=True) if simulated else SerialPort(self.port)
        self.backend.open(**self.settings)

    def read(self, max_bytes: int) -> bytes:
        return bytes(self.backend.read(max_bytes))

    def write(self, data: bytes) -> int:
        return int(self.backend.write(data))

    def flush(self, rx: bool, tx: bool) -> None:
        self.backend.flush(rx=rx, tx=tx)

    def notes(self) -> list[str]:
        return []

    def info(self) -> dict[str, Any]:
        return {"port": self.port, **self.settings}

    def label(self) -> str:
        s = self.settings
        stop = int(s["stopbits"]) if float(s["stopbits"]).is_integer() else s["stopbits"]
        return f"{self.port} {s['baudrate']} {s['bytesize']}{s['parity']}{stop}"

    def close(self) -> None:
        self.backend.close()


def _connect(host: str, port: int, timeout: float) -> socket.socket:
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError as exc:
        raise DeviceError(f"Cannot connect to {host}:{port}: {exc}", category=DEVICE_UNREACHABLE,
                          details={"host": host, "port": port}) from exc
    sock.setblocking(False)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return sock


def _receive(sock: socket.socket, max_bytes: int) -> bytes:
    """What has arrived on a connected socket; ``LinkDown`` when the peer closed or reset it."""
    try:
        data = sock.recv(max_bytes)
    except _WOULD_BLOCK:
        return b""
    except OSError as exc:
        raise LinkDown(str(exc)) from exc
    if not data:
        raise LinkDown("peer closed the connection")
    return data


def _send_all(sock: socket.socket, data: bytes) -> int:
    """Hand ``data`` to the OS; a full send buffer waits briefly instead of dropping bytes."""
    sock.settimeout(CONNECT_TIMEOUT_S)
    try:
        sock.sendall(data)
    except OSError as exc:
        raise DeviceError(f"send failed: {exc}", details={"bytes": len(data)}) from exc
    finally:
        sock.setblocking(False)
    return len(data)


class TcpClientLink:
    """Connects to a device that listens (a module, a controller, a server on the DUT)."""

    kind = "tcp_client"

    def __init__(self, host: str, port: int, timeout_s: float = CONNECT_TIMEOUT_S) -> None:
        self.host, self.port, self.timeout_s = host, port, timeout_s
        self.sock: socket.socket | None = _connect(host, port, timeout_s)

    def reconnect(self) -> None:
        self._drop()
        self.sock = _connect(self.host, self.port, self.timeout_s)

    def read(self, max_bytes: int) -> bytes:
        if self.sock is None:
            return b""  # down: reported once, the adapter reconnects
        try:
            return _receive(self.sock, max_bytes)
        except LinkDown:
            self._drop()
            raise

    def write(self, data: bytes) -> int:
        if self.sock is None:
            raise DeviceError(f"Not connected to {self.host}:{self.port}", category=NOT_CONFIGURED)
        return _send_all(self.sock, data)

    def flush(self, rx: bool, tx: bool) -> None:
        return None  # the OS buffers are not ours to discard

    def notes(self) -> list[str]:
        return []

    def info(self) -> dict[str, Any]:
        return {"host": self.host, "port": self.port, "connected": self.sock is not None}

    def label(self) -> str:
        return f"TCP {self.host}:{self.port}"

    def _drop(self) -> None:
        if self.sock is not None:
            self.sock.close()
            self.sock = None

    def close(self) -> None:
        self._drop()


class TcpServerLink:
    """Listens for the device to connect; one client at a time, a new one replaces the old."""

    kind = "tcp_server"

    def __init__(self, port: int, bind: str = "0.0.0.0") -> None:
        self.bind, self.port = bind, port
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            server.bind((bind, port))
            server.listen(1)
        except OSError as exc:
            server.close()
            category = INVALID_ARGUMENT if exc.errno == errno.EADDRNOTAVAIL else DEVICE_UNREACHABLE
            raise DeviceError(f"Cannot listen on {bind}:{port}: {exc}", category=category) from exc
        server.setblocking(False)
        self.server = server
        self.port = server.getsockname()[1]
        self.client: socket.socket | None = None
        self.peer: str | None = None
        self._notes: list[str] = []

    def _accept(self) -> None:
        try:
            client, address = self.server.accept()
        except _WOULD_BLOCK:
            return
        client.setblocking(False)
        if self.client is not None:
            self._notes.append(f"client {self.peer} replaced")
            self.client.close()
        self.client, self.peer = client, f"{address[0]}:{address[1]}"
        self._notes.append(f"client {self.peer} connected")

    def read(self, max_bytes: int) -> bytes:
        self._accept()
        if self.client is None:
            return b""
        try:
            return _receive(self.client, max_bytes)
        except LinkDown:
            self._notes.append(f"client {self.peer} disconnected")
            self.client.close()
            self.client, self.peer = None, None
            return b""

    def write(self, data: bytes) -> int:
        self._accept()
        if self.client is None:
            raise DeviceError(f"No client is connected to port {self.port}", category=NOT_CONFIGURED)
        return _send_all(self.client, data)

    def flush(self, rx: bool, tx: bool) -> None:
        return None

    def notes(self) -> list[str]:
        notes, self._notes = self._notes, []
        return notes

    def info(self) -> dict[str, Any]:
        return {"bind": self.bind, "port": self.port, "peer": self.peer}

    def label(self) -> str:
        return f"TCP 监听 {self.port}"

    def close(self) -> None:
        if self.client is not None:
            self.client.close()
            self.client = None
        self.server.close()


class UdpLink:
    """A UDP socket: datagrams from any sender are received; sent to ``host:port``, else to the last sender."""

    kind = "udp"

    def __init__(self, local_port: int, host: str = "", port: int = 0, bind: str = "0.0.0.0") -> None:
        self.bind, self.host, self.port = bind, host, port
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind((bind, local_port))
        except OSError as exc:
            sock.close()
            raise DeviceError(f"Cannot bind UDP {bind}:{local_port}: {exc}", category=DEVICE_UNREACHABLE) from exc
        sock.setblocking(False)
        self.sock = sock
        self.local_port = sock.getsockname()[1]
        self.last_peer: tuple[str, int] | None = None

    def read(self, max_bytes: int) -> bytes:
        try:
            data, peer = self.sock.recvfrom(max(max_bytes, 65535))
        except _WOULD_BLOCK:
            return b""
        except ConnectionResetError:  # Windows: the previous datagram hit a closed port
            return b""
        self.last_peer = (str(peer[0]), int(peer[1]))
        return data

    def write(self, data: bytes) -> int:
        target = (self.host, self.port) if self.host and self.port else self.last_peer
        if target is None:
            raise DeviceError("No destination: give host and port, or wait for a datagram to reply to",
                              category=NOT_CONFIGURED)
        try:
            return self.sock.sendto(data, target)
        except OSError as exc:
            raise DeviceError(f"sendto {target[0]}:{target[1]} failed: {exc}") from exc

    def flush(self, rx: bool, tx: bool) -> None:
        return None

    def notes(self) -> list[str]:
        return []

    def info(self) -> dict[str, Any]:
        peer = f"{self.last_peer[0]}:{self.last_peer[1]}" if self.last_peer else None
        return {"localPort": self.local_port, "host": self.host or None, "port": self.port or None,
                "lastPeer": peer}

    def label(self) -> str:
        target = f" → {self.host}:{self.port}" if self.host and self.port else ""
        return f"UDP {self.local_port}{target}"

    def close(self) -> None:
        self.sock.close()
