"""ctypes binding for ADLINK PCIS-DASK (``PCI-Dask64.dll``).

The DLL prints to stdout on load; that was fatal for the stdio transport and
is harmless over HTTP, so no stdout redirection is done here.
"""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import c_double, c_int16, c_uint16
from pathlib import Path
from typing import Any

from hardwareharness_device_sdk import DEVICE_UNREACHABLE, DeviceError

log = logging.getLogger(__name__)

# Official constant from Dask64.h; never hardcode board number 1 elsewhere.
PCI_6208V = 1
ERROR_NO_CARD = -13

DLL_CANDIDATES = (
    r"C:\ADLINK\PCIS-DASK\Lib\PCI-Dask64.dll",
    r"C:\ADLINK\PCIS-DASK\Lib\PCI-Dask.dll",
)


def resolve_dll_path(explicit: str | None = None) -> Path | None:
    for candidate in (explicit, os.environ.get("PCIS_DASK_DLL"), *DLL_CANDIDATES):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    return None


class DaskDriver:
    """Thin PCIS-DASK wrapper returning the vendor's I16 status codes."""

    def __init__(self, dll_path: str | None = None) -> None:
        self.dll_path = dll_path
        self._dll: Any = None

    def _load(self) -> Any:
        if self._dll is not None:
            return self._dll
        path = resolve_dll_path(self.dll_path)
        if path is None:
            raise DeviceError("PCI-Dask64.dll not found. Install PCIS-DASK under C:/ADLINK/PCIS-DASK "
                              "or set PCIS_DASK_DLL to the full DLL path.", category=DEVICE_UNREACHABLE)
        try:
            dll = ctypes.WinDLL(str(path))  # type: ignore[attr-defined]
        except OSError as exc:
            raise DeviceError(f"Failed to load {path}: {exc}", category=DEVICE_UNREACHABLE) from exc
        # I16 Register_Card(U16 CardType, U16 card_num)
        dll.Register_Card.argtypes = [c_uint16, c_uint16]
        dll.Register_Card.restype = c_int16
        # I16 Release_Card(U16 CardNumber)
        dll.Release_Card.argtypes = [c_uint16]
        dll.Release_Card.restype = c_int16
        # I16 AO_VWriteChannel(U16 CardNumber, U16 Channel, F64 Voltage)
        dll.AO_VWriteChannel.argtypes = [c_uint16, c_uint16, c_double]
        dll.AO_VWriteChannel.restype = c_int16
        log.info("Loaded PCIS-DASK: %s", path)
        self._dll = dll
        return dll

    def register(self, card_index: int) -> int:
        return int(self._load().Register_Card(c_uint16(PCI_6208V), c_uint16(card_index)))

    def release(self, handle: int) -> int:
        return int(self._load().Release_Card(c_uint16(handle)))

    def write(self, handle: int, channel: int, volts: float) -> int:
        return int(self._load().AO_VWriteChannel(c_uint16(handle), c_uint16(channel), c_double(volts)))
