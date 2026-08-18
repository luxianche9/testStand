"""ctypes binding for ADLINK PCIS-DASK (PCI-Dask64.dll).

Critical: PCI-Dask64.dll prints noise to stdout on load/enumerate. MCP uses
stdout for JSON-RPC. We temporarily divert the Win32 STD_OUTPUT_HANDLE (and
C fd 1) to NUL around noisy calls, then restore the original handles so the
MCP pipe keeps working.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
from contextlib import contextmanager
from ctypes import c_double, c_int16, c_uint16, c_void_p
from pathlib import Path
from typing import Iterator, Optional

log = logging.getLogger(__name__)

# Official constant from Dask64.h — never hardcode board number 1.
PCI_6208V = 1

# Error codes we care about (negative I16 from Register_Card).
ERROR_NO_CARD = -13

DEFAULT_DLL_CANDIDATES = (
    os.environ.get("PCIS_DASK_DLL", ""),
    r"C:\ADLINK\PCIS-DASK\Lib\PCI-Dask64.dll",
    r"C:\ADLINK\PCIS-DASK\Lib\PCI-Dask.dll",
)

_dll: Optional[ctypes.WinDLL] = None


class SdkError(RuntimeError):
    pass


@contextmanager
def silence_vendor_stdout() -> Iterator[None]:
    """Temporarily send OS-level stdout (incl. C printf) to NUL, then restore.

    Must restore: MCP owns the original stdout pipe for JSON-RPC.
    """
    if sys.platform != "win32":
        yield
        return

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    STD_OUTPUT_HANDLE = -11

    kernel32.GetStdHandle.argtypes = [ctypes.c_int32]
    kernel32.GetStdHandle.restype = c_void_p
    kernel32.SetStdHandle.argtypes = [ctypes.c_int32, c_void_p]
    kernel32.SetStdHandle.restype = ctypes.c_int

    original = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
    try:
        saved_fd = os.dup(1)
    except OSError:
        saved_fd = -1

    devnull = None
    try:
        devnull = open(os.devnull, "w")  # noqa: SIM115 — closed in finally
        kernel32.SetStdHandle(STD_OUTPUT_HANDLE, c_void_p(msvcrt_get_osfhandle(devnull.fileno())))
        try:
            os.dup2(devnull.fileno(), 1)
        except OSError as exc:
            log.debug("dup2 stdout to NUL skipped: %s", exc)
        yield
    finally:
        try:
            if saved_fd >= 0:
                os.dup2(saved_fd, 1)
                os.close(saved_fd)
        except OSError as exc:
            log.warning("restore stdout fd failed: %s", exc)
        if original:
            kernel32.SetStdHandle(STD_OUTPUT_HANDLE, original)
        if devnull is not None:
            devnull.close()


def msvcrt_get_osfhandle(fd: int) -> int:
    import msvcrt

    return msvcrt.get_osfhandle(fd)


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
            "PCI-Dask64.dll not found. Install PCIS-DASK under C:/ADLINK/PCIS-DASK "
            "or set PCIS_DASK_DLL to the full DLL path."
        )

    with silence_vendor_stdout():
        try:
            _dll = ctypes.WinDLL(str(path))
        except OSError as exc:
            raise SdkError(f"Failed to load {path}: {exc}") from exc

    # I16 Register_Card(U16 CardType, U16 card_num)
    _dll.Register_Card.argtypes = [c_uint16, c_uint16]
    _dll.Register_Card.restype = c_int16

    # I16 Release_Card(U16 CardNumber)
    _dll.Release_Card.argtypes = [c_uint16]
    _dll.Release_Card.restype = c_int16

    # I16 AO_VWriteChannel(U16 CardNumber, U16 Channel, F64 Voltage)
    _dll.AO_VWriteChannel.argtypes = [c_uint16, c_uint16, c_double]
    _dll.AO_VWriteChannel.restype = c_int16

    # I16 AO_VoltScale(U16 wCardNumber, U16 wChannel, F64 voltage, I16 *binValue)
    _dll.AO_VoltScale.argtypes = [c_uint16, c_uint16, c_double, ctypes.POINTER(c_int16)]
    _dll.AO_VoltScale.restype = c_int16

    log.info("Loaded PCIS-DASK: %s", path)
    return _dll


def register_card(card_type: int, card_num: int) -> int:
    dll = load_dll()
    with silence_vendor_stdout():
        rc = int(dll.Register_Card(c_uint16(card_type), c_uint16(card_num)))
    return rc


def release_card(handle: int) -> int:
    dll = load_dll()
    with silence_vendor_stdout():
        return int(dll.Release_Card(c_uint16(handle)))


def ao_vwrite_channel(handle: int, channel: int, volts: float) -> int:
    dll = load_dll()
    with silence_vendor_stdout():
        return int(dll.AO_VWriteChannel(c_uint16(handle), c_uint16(channel), c_double(volts)))


def ao_volt_scale(handle: int, channel: int, volts: float) -> tuple[int, int]:
    dll = load_dll()
    bin_val = c_int16(0)
    with silence_vendor_stdout():
        rc = int(
            dll.AO_VoltScale(
                c_uint16(handle),
                c_uint16(channel),
                c_double(volts),
                ctypes.byref(bin_val),
            )
        )
    return rc, int(bin_val.value)
