"""Dry-run PComm.

Modelled: which ports are open, each port's UART configuration (so
get_line_status reports what configure_port set) and the RX/TX FIFOs that
flush acts on. Not modelled: the peer. Nothing ever arrives on RX unless
``HARDWARE_DRY_RUN_SERIAL_LOOPBACK=1`` opts into echoing every accepted TX
byte back, which demos the serial streams and transact without a loopback plug.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping
from dataclasses import dataclass

from hardwareharness_device_sdk.sim import serial_loopback_enabled

from .driver import BAUD_CODES, FLUSH_BOTH, FLUSH_RX, RATES, SIO_OK

SIO_BADPORT = -1
LSTATUS_IDLE = 0x0B  # CTS|DSR|DCD as the bench card reports with no cable


@dataclass
class _Port:
    baud_code: int = BAUD_CODES[9600]
    mode: int = 0x03  # 8N1
    flow: int = 0
    rx: bytearray | None = None

    def __post_init__(self) -> None:
        self.rx = bytearray()


class SimulatedPComm:
    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self.loopback = serial_loopback_enabled(env)
        self.ports: dict[int, _Port] = {}
        self.writes: list[tuple[int, bytes]] = []
        self._lock = threading.Lock()

    def _port(self, port: int) -> _Port | None:
        return self.ports.get(port)

    def inject(self, port: int, data: bytes) -> None:
        """Test hook: bytes a peer sent."""
        with self._lock:
            state = self.ports[port]
            assert state.rx is not None
            state.rx.extend(data)

    def sio_open(self, port: int) -> int:
        with self._lock:
            self.ports.setdefault(port, _Port())
        return SIO_OK

    def sio_close(self, port: int) -> int:
        with self._lock:
            return SIO_OK if self.ports.pop(port, None) is not None else SIO_BADPORT

    def sio_ioctl(self, port: int, baud_code: int, mode: int) -> int:
        with self._lock:
            state = self._port(port)
            if state is None:
                return SIO_BADPORT
            state.baud_code, state.mode = baud_code, mode
        return SIO_OK

    def sio_flowctrl(self, port: int, mode: int) -> int:
        with self._lock:
            state = self._port(port)
            if state is None:
                return SIO_BADPORT
            state.flow = mode
        return SIO_OK

    def sio_set_read_timeouts(self, port: int, total: int, interval: int) -> int:
        return SIO_OK if port in self.ports else SIO_BADPORT

    def sio_write(self, port: int, data: bytes) -> int:
        with self._lock:
            state = self._port(port)
            if state is None or state.rx is None:
                return SIO_BADPORT
            self.writes.append((port, bytes(data)))
            if self.loopback:
                state.rx.extend(data)
        return len(data)

    def sio_read(self, port: int, max_len: int) -> tuple[int, bytes]:
        with self._lock:
            state = self._port(port)
            if state is None or state.rx is None:
                return SIO_BADPORT, b""
            data = bytes(state.rx[:max_len])
            del state.rx[:max_len]
        return len(data), data

    def sio_flush(self, port: int, what: int) -> int:
        with self._lock:
            state = self._port(port)
            if state is None or state.rx is None:
                return SIO_BADPORT
            if what in (FLUSH_RX, FLUSH_BOTH):
                state.rx.clear()
        return SIO_OK

    def sio_getbaud(self, port: int) -> int:
        state = self._port(port)
        return RATES[state.baud_code] if state else SIO_BADPORT

    def sio_getmode(self, port: int) -> int:
        state = self._port(port)
        return state.mode if state else SIO_BADPORT

    def sio_getflow(self, port: int) -> int:
        state = self._port(port)
        return state.flow if state else SIO_BADPORT

    def sio_lstatus(self, port: int) -> int:
        return LSTATUS_IDLE if port in self.ports else SIO_BADPORT
