"""Windows serial ports (COMn) for adapters, through the Win32 API with ctypes.

Many test resources are reached over a COM port: RS-232/422/485 instruments, Modbus modules,
multi-port serial cards whose driver creates COM ports. :class:`SerialPort` opens one port,
configures it and reads without blocking (the reader thread of a byte stream polls it and
calls ``idle()`` after every read, see the streams reference); :class:`SimulatedSerialPort` is
the dry-run twin with the same interface; :func:`list_ports` names the ports the system has.

Errors raise :class:`DeviceError`: a port that does not exist or is held by another program is
``DEVICE_UNREACHABLE`` (the SDK retries opening), bad settings are ``INVALID_ARGUMENT``.
"""

from __future__ import annotations

import ctypes
import sys
import threading
from ctypes import wintypes
from typing import Any, Protocol

from .errors import DEVICE_UNREACHABLE, INVALID_ARGUMENT, DeviceError

PARITIES = {"N": 0, "O": 1, "E": 2, "M": 3, "S": 4}
STOP_BITS = {1: 0, 1.5: 1, 2: 2}
BAUD_RATES = (110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 128000,
              230400, 256000, 460800, 921600)

_GENERIC_READ = 0x80000000
_GENERIC_WRITE = 0x40000000
_OPEN_EXISTING = 3
_INVALID_HANDLE = ctypes.c_void_p(-1).value
_PURGE_TXCLEAR = 0x0004
_PURGE_RXCLEAR = 0x0008
_MAXDWORD = 0xFFFFFFFF
_ERROR_FILE_NOT_FOUND = 2
_ERROR_ACCESS_DENIED = 5
_ERROR_BUSY = 170


class _DCB(ctypes.Structure):
    _fields_ = [
        ("DCBlength", wintypes.DWORD),
        ("BaudRate", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("wReserved", wintypes.WORD),
        ("XonLim", wintypes.WORD),
        ("XoffLim", wintypes.WORD),
        ("ByteSize", wintypes.BYTE),
        ("Parity", wintypes.BYTE),
        ("StopBits", wintypes.BYTE),
        ("XonChar", ctypes.c_char),
        ("XoffChar", ctypes.c_char),
        ("ErrorChar", ctypes.c_char),
        ("EofChar", ctypes.c_char),
        ("EvtChar", ctypes.c_char),
        ("wReserved1", wintypes.WORD),
    ]


class _COMMTIMEOUTS(ctypes.Structure):
    _fields_ = [
        ("ReadIntervalTimeout", wintypes.DWORD),
        ("ReadTotalTimeoutMultiplier", wintypes.DWORD),
        ("ReadTotalTimeoutConstant", wintypes.DWORD),
        ("WriteTotalTimeoutMultiplier", wintypes.DWORD),
        ("WriteTotalTimeoutConstant", wintypes.DWORD),
    ]


class _COMSTAT(ctypes.Structure):
    _fields_ = [("flags", wintypes.DWORD), ("cbInQue", wintypes.DWORD), ("cbOutQue", wintypes.DWORD)]


def _kernel32() -> Any:
    if sys.platform != "win32":
        raise DeviceError("Serial ports need Windows", category=DEVICE_UNREACHABLE)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    for name, arguments in (
        ("GetCommState", [wintypes.HANDLE, ctypes.POINTER(_DCB)]),
        ("SetCommState", [wintypes.HANDLE, ctypes.POINTER(_DCB)]),
        ("SetCommTimeouts", [wintypes.HANDLE, ctypes.POINTER(_COMMTIMEOUTS)]),
        ("ReadFile", [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                      ctypes.c_void_p]),
        ("WriteFile", [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                       ctypes.c_void_p]),
        ("PurgeComm", [wintypes.HANDLE, wintypes.DWORD]),
        ("ClearCommError", [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(_COMSTAT)]),
        ("SetupComm", [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]),
        ("CloseHandle", [wintypes.HANDLE]),
    ):
        function = getattr(kernel, name)
        function.argtypes = arguments
        function.restype = wintypes.BOOL
    return kernel


def list_ports() -> list[dict[str, str]]:
    """``[{port, device}]`` from ``HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM``, e.g.
    ``{"port": "COM3", "device": "\\\\Device\\\\TTYFPGA-0"}``; empty off Windows."""
    if sys.platform != "win32":
        return []
    import winreg

    ports: list[dict[str, str]] = []
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DEVICEMAP\SERIALCOMM")
    except OSError:
        return ports
    with key:
        index = 0
        while True:
            try:
                device, port, _ = winreg.EnumValue(key, index)
            except OSError:
                break
            ports.append({"port": str(port), "device": str(device)})
            index += 1
    return sorted(ports, key=lambda item: (len(item["port"]), item["port"]))


def validate_settings(baudrate: int, bytesize: int, parity: str, stopbits: float) -> None:
    if not 50 <= baudrate <= 4_000_000:
        raise DeviceError(f"baud rate {baudrate} out of range 50..4000000", category=INVALID_ARGUMENT)
    if bytesize not in (5, 6, 7, 8):
        raise DeviceError(f"data bits {bytesize} must be 5..8", category=INVALID_ARGUMENT)
    if parity not in PARITIES:
        raise DeviceError(f"parity {parity!r} must be one of N O E M S", category=INVALID_ARGUMENT)
    if stopbits not in STOP_BITS:
        raise DeviceError(f"stop bits {stopbits} must be 1, 1.5 or 2", category=INVALID_ARGUMENT)


class SerialBackend(Protocol):
    """What adapters use; :class:`SerialPort` and :class:`SimulatedSerialPort` implement it."""

    port: str

    @property
    def is_open(self) -> bool: ...
    def open(self, baudrate: int = 9600, bytesize: int = 8, parity: str = "N",
             stopbits: float = 1) -> None: ...
    def configure(self, baudrate: int, bytesize: int = 8, parity: str = "N",
                  stopbits: float = 1) -> None: ...
    def write(self, data: bytes) -> int: ...
    def read(self, max_bytes: int = 4096) -> bytes: ...
    def in_waiting(self) -> int: ...
    def flush(self, rx: bool = True, tx: bool = True) -> None: ...
    def close(self) -> None: ...


class SerialPort:
    """One Windows COM port. ``read`` never blocks: it returns what has arrived (maybe ``b""``)."""

    def __init__(self, port: str) -> None:
        name = port.strip().upper()
        if not name.startswith("COM") or not name[3:].isdigit():
            raise DeviceError(f"{port!r} is not a COM port name such as COM3", category=INVALID_ARGUMENT)
        self.port = name
        self.settings: dict[str, Any] = {}
        self._handle: int | None = None
        self._kernel: Any = None

    @property
    def is_open(self) -> bool:
        return self._handle is not None

    def _fail(self, action: str, category: str = DEVICE_UNREACHABLE) -> DeviceError:
        code = ctypes.get_last_error()  # type: ignore[attr-defined]
        message = ctypes.FormatError(code).strip() if code else "unknown error"  # type: ignore[attr-defined]
        return DeviceError(f"{self.port}: {action} failed ({code}: {message})", category=category,
                           details={"port": self.port, "winError": code})

    def open(self, baudrate: int = 9600, bytesize: int = 8, parity: str = "N", stopbits: float = 1) -> None:
        if self._handle is not None:
            return
        validate_settings(baudrate, bytesize, parity, stopbits)
        self._kernel = kernel = _kernel32()
        handle = kernel.CreateFileW(f"\\\\.\\{self.port}", _GENERIC_READ | _GENERIC_WRITE, 0, None,
                                    _OPEN_EXISTING, 0, None)
        if handle in (None, _INVALID_HANDLE):
            code = ctypes.get_last_error()  # type: ignore[attr-defined]
            reason = {_ERROR_FILE_NOT_FOUND: "does not exist",
                      _ERROR_ACCESS_DENIED: "is in use by another program",
                      _ERROR_BUSY: "is busy (in use by another program or device instance)"}.get(code, f"cannot be opened ({code})")
            raise DeviceError(f"{self.port} {reason}", category=DEVICE_UNREACHABLE,
                              details={"port": self.port, "winError": code})
        self._handle = handle
        try:
            kernel.SetupComm(handle, 65536, 65536)
            timeouts = _COMMTIMEOUTS(_MAXDWORD, 0, 0, 0, 2000)  # reads return at once; writes ≤ 2 s
            if not kernel.SetCommTimeouts(handle, ctypes.byref(timeouts)):
                raise self._fail("SetCommTimeouts")
            self.configure(baudrate, bytesize, parity, stopbits)
            kernel.PurgeComm(handle, _PURGE_RXCLEAR | _PURGE_TXCLEAR)
        except BaseException:
            self.close()
            raise

    def configure(self, baudrate: int, bytesize: int = 8, parity: str = "N", stopbits: float = 1) -> None:
        validate_settings(baudrate, bytesize, parity, stopbits)
        handle = self._require()
        dcb = _DCB()
        dcb.DCBlength = ctypes.sizeof(_DCB)
        if not self._kernel.GetCommState(handle, ctypes.byref(dcb)):
            raise self._fail("GetCommState")
        dcb.BaudRate = baudrate
        dcb.ByteSize = bytesize
        dcb.Parity = PARITIES[parity]
        dcb.StopBits = STOP_BITS[stopbits]
        flags = dcb.flags
        flags |= 0x1  # fBinary
        flags = flags | 0x2 if parity != "N" else flags & ~0x2  # fParity
        flags &= ~(0x4 | 0x8 | 0x40 | 0x100 | 0x200)  # no CTS/DSR flow, DSR sensitivity, XON/XOFF
        flags = (flags & ~0x30) | (1 << 4)  # DTR on
        flags = (flags & ~0x3000) | (1 << 12)  # RTS on
        dcb.flags = flags
        if not self._kernel.SetCommState(handle, ctypes.byref(dcb)):
            raise self._fail("SetCommState", INVALID_ARGUMENT)
        self.settings = {"baudrate": baudrate, "bytesize": bytesize, "parity": parity, "stopbits": stopbits}

    def _require(self) -> int:
        if self._handle is None:
            raise DeviceError(f"{self.port} is not open", category=DEVICE_UNREACHABLE)
        return self._handle

    def write(self, data: bytes) -> int:
        handle = self._require()
        written = wintypes.DWORD(0)
        buffer = ctypes.create_string_buffer(bytes(data), len(data))
        if not self._kernel.WriteFile(handle, buffer, len(data), ctypes.byref(written), None):
            raise self._fail("WriteFile")
        return int(written.value)

    def in_waiting(self) -> int:
        handle = self._require()
        errors = wintypes.DWORD(0)
        status = _COMSTAT()
        if not self._kernel.ClearCommError(handle, ctypes.byref(errors), ctypes.byref(status)):
            raise self._fail("ClearCommError")
        return int(status.cbInQue)

    def read(self, max_bytes: int = 4096) -> bytes:
        handle = self._require()
        if max_bytes <= 0:
            return b""
        buffer = ctypes.create_string_buffer(max_bytes)
        received = wintypes.DWORD(0)
        if not self._kernel.ReadFile(handle, buffer, max_bytes, ctypes.byref(received), None):
            raise self._fail("ReadFile")
        return buffer.raw[: received.value]

    def flush(self, rx: bool = True, tx: bool = True) -> None:
        handle = self._require()
        mask = (_PURGE_RXCLEAR if rx else 0) | (_PURGE_TXCLEAR if tx else 0)
        if mask and not self._kernel.PurgeComm(handle, mask):
            raise self._fail("PurgeComm")

    def close(self) -> None:
        handle, self._handle = self._handle, None
        if handle is not None and self._kernel is not None:
            self._kernel.CloseHandle(handle)


class SimulatedSerialPort:
    """Dry-run twin of :class:`SerialPort`: nothing arrives unless ``loopback`` echoes what is
    written (or a test ``inject``s bytes)."""

    def __init__(self, port: str, loopback: bool = False) -> None:
        self.port = port.strip().upper()
        self.loopback = loopback
        self.settings: dict[str, Any] = {}
        self.written = bytearray()
        self._rx = bytearray()
        self._open = False
        self._lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        return self._open

    def open(self, baudrate: int = 9600, bytesize: int = 8, parity: str = "N", stopbits: float = 1) -> None:
        validate_settings(baudrate, bytesize, parity, stopbits)
        self._open = True
        self.configure(baudrate, bytesize, parity, stopbits)

    def configure(self, baudrate: int, bytesize: int = 8, parity: str = "N", stopbits: float = 1) -> None:
        validate_settings(baudrate, bytesize, parity, stopbits)
        self._require()
        self.settings = {"baudrate": baudrate, "bytesize": bytesize, "parity": parity, "stopbits": stopbits}

    def _require(self) -> None:
        if not self._open:
            raise DeviceError(f"{self.port} is not open", category=DEVICE_UNREACHABLE)

    def inject(self, data: bytes) -> None:
        with self._lock:
            self._rx += data

    def write(self, data: bytes) -> int:
        self._require()
        with self._lock:
            self.written += data
            if self.loopback:
                self._rx += data
        return len(data)

    def in_waiting(self) -> int:
        self._require()
        return len(self._rx)

    def read(self, max_bytes: int = 4096) -> bytes:
        self._require()
        with self._lock:
            data = bytes(self._rx[:max_bytes])
            del self._rx[:max_bytes]
        return data

    def flush(self, rx: bool = True, tx: bool = True) -> None:
        self._require()
        with self._lock:
            if rx:
                self._rx.clear()

    def close(self) -> None:
        self._open = False
