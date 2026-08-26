"""ctypes binding for Moxa PComm (PCOMM.dll)."""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import c_char_p, c_int, c_long, c_void_p
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# Return codes
SIO_OK = 0
SIO_BADPORT = -1
SIO_OUTCONTROL = -2
SIO_NODATA = -5
SIO_RTS_BY_HW = -6
SIO_BADPARM = -7

# Baud codes (PCOMM.H) — sio_ioctl takes codes; sio_getbaud returns real rate
BAUD_CODES: dict[int, int] = {
    50: 0x00,
    75: 0x01,
    110: 0x02,
    134: 0x03,
    150: 0x04,
    300: 0x05,
    600: 0x06,
    1200: 0x07,
    1800: 0x08,
    2400: 0x09,
    4800: 0x0A,
    7200: 0x0B,
    9600: 0x0C,
    19200: 0x0D,
    38400: 0x0E,
    57600: 0x0F,
    115200: 0x10,
    230400: 0x11,
    460800: 0x12,
    921600: 0x13,
}

# Mode bits
BIT_5, BIT_6, BIT_7, BIT_8 = 0x00, 0x01, 0x02, 0x03
STOP_1, STOP_2 = 0x00, 0x04
P_NONE, P_ODD, P_EVEN, P_MRK, P_SPC = 0x00, 0x08, 0x18, 0x28, 0x38

# Flush: measured 0=rx, 1=tx, 2=both
FLUSH_RX, FLUSH_TX, FLUSH_BOTH = 0, 1, 2

# Read timeout: (MAXDWORD, 0) = poll / immediate return
MAXDWORD = 0xFFFFFFFF

DEFAULT_DLL_CANDIDATES = (
    os.environ.get("PCOMM_DLL", ""),
    r"C:\Program Files\Moxa\PCommLite 1.9\Lib\x64\PCOMM.dll",
    r"C:\Program Files (x86)\Moxa\PCommLite 1.9\Lib\x64\PCOMM.dll",
)

_dll: Optional[ctypes.WinDLL] = None


class SdkError(RuntimeError):
    pass


def dry_run() -> bool:
    return os.environ.get("HARDWARE_DRY_RUN", "").strip() in ("1", "true", "TRUE", "yes")


def resolve_dll_path() -> Optional[Path]:
    for cand in DEFAULT_DLL_CANDIDATES:
        if not cand:
            continue
        p = Path(cand)
        if p.is_file():
            return p
    return None


def load_dll() -> ctypes.WinDLL:
    global _dll
    if _dll is not None:
        return _dll
    if dry_run():
        raise SdkError("HARDWARE_DRY_RUN=1 — real DLL not loaded")

    path = resolve_dll_path()
    if path is None:
        raise SdkError(
            "PCOMM.dll not found. Install PComm Lite 1.9 or set PCOMM_DLL to the full path."
        )

    try:
        _dll = ctypes.WinDLL(str(path))
    except OSError as exc:
        raise SdkError(f"Failed to load {path}: {exc}") from exc

    _dll.sio_open.argtypes = [c_int]
    _dll.sio_open.restype = c_int
    _dll.sio_close.argtypes = [c_int]
    _dll.sio_close.restype = c_int
    _dll.sio_ioctl.argtypes = [c_int, c_int, c_int]
    _dll.sio_ioctl.restype = c_int
    _dll.sio_getbaud.argtypes = [c_int]
    _dll.sio_getbaud.restype = c_long
    _dll.sio_getmode.argtypes = [c_int]
    _dll.sio_getmode.restype = c_int
    _dll.sio_getflow.argtypes = [c_int]
    _dll.sio_getflow.restype = c_int
    _dll.sio_lstatus.argtypes = [c_int]
    _dll.sio_lstatus.restype = c_int
    _dll.sio_flush.argtypes = [c_int, c_int]
    _dll.sio_flush.restype = c_int
    _dll.sio_flowctrl.argtypes = [c_int, c_int]
    _dll.sio_flowctrl.restype = c_int
    _dll.sio_SetReadTimeouts.argtypes = [c_int, c_int, c_int]
    _dll.sio_SetReadTimeouts.restype = c_int
    _dll.sio_write.argtypes = [c_int, c_char_p, c_int]
    _dll.sio_write.restype = c_int
    _dll.sio_read.argtypes = [c_int, c_void_p, c_int]
    _dll.sio_read.restype = c_int
    _dll.sio_iqueue.argtypes = [c_int]
    _dll.sio_iqueue.restype = c_int

    log.info("Loaded PComm: %s", path)
    return _dll


def sio_open(port: int) -> int:
    return int(load_dll().sio_open(port))


def sio_close(port: int) -> int:
    return int(load_dll().sio_close(port))


def sio_ioctl(port: int, baud_code: int, mode: int) -> int:
    return int(load_dll().sio_ioctl(port, baud_code, mode))


def sio_getbaud(port: int) -> int:
    return int(load_dll().sio_getbaud(port))


def sio_getmode(port: int) -> int:
    return int(load_dll().sio_getmode(port))


def sio_getflow(port: int) -> int:
    return int(load_dll().sio_getflow(port))


def sio_lstatus(port: int) -> int:
    return int(load_dll().sio_lstatus(port))


def sio_flush(port: int, what: int) -> int:
    return int(load_dll().sio_flush(port, what))


def sio_flowctrl(port: int, mode: int) -> int:
    return int(load_dll().sio_flowctrl(port, mode))


def sio_set_read_timeouts(port: int, total: int, interval: int) -> int:
    return int(load_dll().sio_SetReadTimeouts(port, total, interval))


def sio_write(port: int, data: bytes) -> int:
    return int(load_dll().sio_write(port, data, len(data)))


def sio_read(port: int, max_len: int) -> tuple[int, bytes]:
    buf = ctypes.create_string_buffer(max_len)
    n = int(load_dll().sio_read(port, buf, max_len))
    if n < 0:
        return n, b""
    return n, buf.raw[:n]


def sio_iqueue(port: int) -> int:
    return int(load_dll().sio_iqueue(port))


def baud_to_code(baud: int) -> Optional[int]:
    return BAUD_CODES.get(int(baud))


def build_mode(data_bits: int = 8, parity: str = "N", stop_bits: int = 1) -> int:
    db = {5: BIT_5, 6: BIT_6, 7: BIT_7, 8: BIT_8}.get(data_bits)
    if db is None:
        raise ValueError(f"data_bits must be 5..8, got {data_bits}")
    pmap = {"N": P_NONE, "O": P_ODD, "E": P_EVEN, "M": P_MRK, "S": P_SPC}
    p = pmap.get(parity.upper())
    if p is None:
        raise ValueError(f"parity must be one of N/O/E/M/S, got {parity}")
    sb = STOP_2 if stop_bits == 2 else STOP_1 if stop_bits == 1 else None
    if sb is None:
        raise ValueError(f"stop_bits must be 1 or 2, got {stop_bits}")
    return db | p | sb


def decode_mode(mode: int) -> dict:
    data_bits = 5 + (mode & 0x03)
    stop_bits = 2 if (mode & STOP_2) else 1
    p = mode & 0x38  # three parity bits — not 0x18
    parity = {P_NONE: "N", P_ODD: "O", P_EVEN: "E", P_MRK: "M", P_SPC: "S"}.get(p, "?")
    return {"data_bits": data_bits, "parity": parity, "stop_bits": stop_bits, "mode": mode}
