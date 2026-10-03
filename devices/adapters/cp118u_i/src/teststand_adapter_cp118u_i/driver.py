"""ctypes binding for Moxa PComm (PCOMM.dll)."""

from __future__ import annotations

import ctypes
import os
from ctypes import c_char_p, c_int, c_long, c_void_p
from pathlib import Path
from typing import Any, Protocol

from teststand_device_sdk import DEVICE_UNREACHABLE, INVALID_ARGUMENT, DeviceError

SIO_OK = 0
SIO_RTS_BY_HW = -6  # sio_flowctrl: RTS is owned by hardware flow control, not an error

# Baud codes (PCOMM.H): sio_ioctl takes codes, sio_getbaud returns the real rate.
BAUD_CODES: dict[int, int] = {
    50: 0x00, 75: 0x01, 110: 0x02, 134: 0x03, 150: 0x04, 300: 0x05, 600: 0x06, 1200: 0x07, 1800: 0x08,
    2400: 0x09, 4800: 0x0A, 7200: 0x0B, 9600: 0x0C, 19200: 0x0D, 38400: 0x0E, 57600: 0x0F, 115200: 0x10,
    230400: 0x11, 460800: 0x12, 921600: 0x13,
}
RATES = {code: rate for rate, code in BAUD_CODES.items()}

BIT_5, BIT_6, BIT_7, BIT_8 = 0x00, 0x01, 0x02, 0x03
STOP_1, STOP_2 = 0x00, 0x04
P_NONE, P_ODD, P_EVEN, P_MRK, P_SPC = 0x00, 0x08, 0x18, 0x28, 0x38
PARITY_BITS = {"N": P_NONE, "O": P_ODD, "E": P_EVEN, "M": P_MRK, "S": P_SPC}

# Flush selector, measured on the bench: 0=rx, 1=tx, 2=both.
FLUSH_RX, FLUSH_TX, FLUSH_BOTH = 0, 1, 2
FLUSH_CODES = {"rx": FLUSH_RX, "tx": FLUSH_TX, "both": FLUSH_BOTH}

# Read timeouts (MAXDWORD, 0) = poll: sio_read returns immediately.
MAXDWORD = 0xFFFFFFFF

DLL_CANDIDATES = (
    r"C:\Program Files\Moxa\PCommLite 1.9\Lib\x64\PCOMM.dll",
    r"C:\Program Files (x86)\Moxa\PCommLite 1.9\Lib\x64\PCOMM.dll",
)


class PCommBackend(Protocol):
    def sio_open(self, port: int) -> int: ...
    def sio_close(self, port: int) -> int: ...
    def sio_ioctl(self, port: int, baud_code: int, mode: int) -> int: ...
    def sio_flowctrl(self, port: int, mode: int) -> int: ...
    def sio_set_read_timeouts(self, port: int, total: int, interval: int) -> int: ...
    def sio_write(self, port: int, data: bytes) -> int: ...
    def sio_read(self, port: int, max_len: int) -> tuple[int, bytes]: ...
    def sio_flush(self, port: int, what: int) -> int: ...
    def sio_getbaud(self, port: int) -> int: ...
    def sio_getmode(self, port: int) -> int: ...
    def sio_getflow(self, port: int) -> int: ...
    def sio_lstatus(self, port: int) -> int: ...


def build_mode(data_bits: int = 8, parity: str = "N", stop_bits: int = 1) -> int:
    bits = {5: BIT_5, 6: BIT_6, 7: BIT_7, 8: BIT_8}.get(data_bits)
    parity_bits = PARITY_BITS.get(parity.upper())
    stop = {1: STOP_1, 2: STOP_2}.get(stop_bits)
    if bits is None or parity_bits is None or stop is None:
        raise DeviceError(f"invalid frame {data_bits}{parity}{stop_bits}", category=INVALID_ARGUMENT)
    return bits | parity_bits | stop


def decode_mode(mode: int) -> dict[str, Any]:
    parity = {value: key for key, value in PARITY_BITS.items()}.get(mode & 0x38, "?")  # three parity bits, not 0x18
    return {"data_bits": 5 + (mode & 0x03), "parity": parity, "stop_bits": 2 if mode & STOP_2 else 1}


def frame(mode: int) -> str:
    decoded = decode_mode(mode)
    return f"{decoded['data_bits']}{decoded['parity']}{decoded['stop_bits']}"


class PComm:
    """Lazily loaded PCOMM.dll; every method returns the raw PComm return code."""

    def __init__(self, dll_path: str | None = None) -> None:
        self.dll_path = dll_path
        self._dll: Any = None

    def resolve(self) -> Path | None:
        for candidate in (self.dll_path, os.environ.get("PCOMM_DLL"), *DLL_CANDIDATES):
            if candidate and Path(candidate).is_file():
                return Path(candidate)
        return None

    @property
    def dll(self) -> Any:
        if self._dll is not None:
            return self._dll
        path = self.resolve()
        if path is None:
            raise DeviceError("PCOMM.dll not found. Install PComm Lite 1.9, set settings.dllPath or PCOMM_DLL.",
                              category=DEVICE_UNREACHABLE)
        try:
            dll = ctypes.WinDLL(str(path))  # type: ignore[attr-defined]
        except OSError as exc:
            raise DeviceError(f"Failed to load {path}: {exc}", category=DEVICE_UNREACHABLE) from exc
        signatures: dict[str, tuple[list[Any], Any]] = {
            "sio_open": ([c_int], c_int), "sio_close": ([c_int], c_int),
            "sio_ioctl": ([c_int, c_int, c_int], c_int), "sio_getbaud": ([c_int], c_long),
            "sio_getmode": ([c_int], c_int), "sio_getflow": ([c_int], c_int), "sio_lstatus": ([c_int], c_int),
            "sio_flush": ([c_int, c_int], c_int), "sio_flowctrl": ([c_int, c_int], c_int),
            "sio_SetReadTimeouts": ([c_int, c_int, c_int], c_int), "sio_write": ([c_int, c_char_p, c_int], c_int),
            "sio_read": ([c_int, c_void_p, c_int], c_int),
        }
        for name, (argtypes, restype) in signatures.items():
            getattr(dll, name).argtypes = argtypes
            getattr(dll, name).restype = restype
        self._dll = dll
        return dll

    def sio_open(self, port: int) -> int:
        return int(self.dll.sio_open(port))

    def sio_close(self, port: int) -> int:
        return int(self.dll.sio_close(port))

    def sio_ioctl(self, port: int, baud_code: int, mode: int) -> int:
        return int(self.dll.sio_ioctl(port, baud_code, mode))

    def sio_flowctrl(self, port: int, mode: int) -> int:
        return int(self.dll.sio_flowctrl(port, mode))

    def sio_set_read_timeouts(self, port: int, total: int, interval: int) -> int:
        return int(self.dll.sio_SetReadTimeouts(port, total, interval))

    def sio_write(self, port: int, data: bytes) -> int:
        return int(self.dll.sio_write(port, data, len(data)))

    def sio_read(self, port: int, max_len: int) -> tuple[int, bytes]:
        buffer = ctypes.create_string_buffer(max_len)
        count = int(self.dll.sio_read(port, buffer, max_len))
        return (count, b"") if count < 0 else (count, buffer.raw[:count])

    def sio_flush(self, port: int, what: int) -> int:
        return int(self.dll.sio_flush(port, what))

    def sio_getbaud(self, port: int) -> int:
        return int(self.dll.sio_getbaud(port))

    def sio_getmode(self, port: int) -> int:
        return int(self.dll.sio_getmode(port))

    def sio_getflow(self, port: int) -> int:
        return int(self.dll.sio_getflow(port))

    def sio_lstatus(self, port: int) -> int:
        return int(self.dll.sio_lstatus(port))
