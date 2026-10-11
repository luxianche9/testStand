"""ctypes binding of ``DA6401_JC.dll`` (Devices-JC JCXD-DA-X-6401 driver, x64).

Every function is ``__stdcall`` and returns 0 on success (software manual V1.0 §3). The x64 DLL
ships in this package (``bin/``); the kernel driver ``DA6401_JC`` must be installed on the PC.
The binding only wraps calls and returns raw codes: the adapter decides what a code means.
"""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import POINTER, byref, c_float, c_int, c_ubyte, wintypes
from pathlib import Path
from typing import Any

from teststand_device_sdk import DEVICE_UNREACHABLE, DeviceError

log = logging.getLogger(__name__)

PACKAGED_DLL = Path(__file__).resolve().parent / "bin" / "DA6401_JC.dll"
MAX_CARDS = 8
"""Card ids tried when a card is selected by serial number."""


class DevParInfo(ctypes.Structure):
    """``JCDEVPARST``: card identity as the driver reports it."""

    _fields_ = [(name, wintypes.DWORD) for name in
                ("dwCardType", "dwhwVersion", "dwdvrVersion", "dwlibVersion", "dwBoardID", "dwSN", "dwChMax")]

    def as_dict(self) -> dict[str, int]:
        return {"cardType": self.dwCardType, "hwVersion": self.dwhwVersion, "driverVersion": self.dwdvrVersion,
                "libVersion": self.dwlibVersion, "boardId": self.dwBoardID, "serialNumber": self.dwSN,
                "channelMax": self.dwChMax}


SIGNATURES: dict[str, tuple[list[Any], Any]] = {
    "DA6401_JC_OpenDev": ([POINTER(wintypes.HANDLE), c_ubyte], c_int),
    "DA6401_JC_CloseDev": ([wintypes.HANDLE], c_int),
    "DA6401_JC_ResetDev": ([wintypes.HANDLE], c_int),
    "DA6401_JC_GetDevParInfo": ([wintypes.HANDLE, POINTER(DevParInfo)], c_int),
    "DA6401_JC_DA_CreateVoltChan": ([wintypes.HANDLE, c_ubyte, c_ubyte], c_int),
    "DA6401_JC_DA_WriteVoltage": ([wintypes.HANDLE, c_ubyte, c_float], c_int),
}


def resolve_dll(explicit: str | None) -> Path:
    for candidate in (explicit, os.environ.get("DA6401_JC_DLL"), str(PACKAGED_DLL)):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise DeviceError("DA6401_JC.dll not found; set settings.dllPath", category=DEVICE_UNREACHABLE)


class Da6401Driver:
    """Raw vendor calls; the DLL loads on first use, so constructing this touches nothing."""

    def __init__(self, dll_path: str | None = None) -> None:
        self.dll_path = dll_path
        self._dll: Any = None

    def _load(self) -> Any:
        if self._dll is None:
            path = resolve_dll(self.dll_path)
            try:
                dll = ctypes.WinDLL(str(path))  # type: ignore[attr-defined]
            except OSError as exc:
                raise DeviceError(f"cannot load {path}: {exc}", category=DEVICE_UNREACHABLE) from exc
            for name, (arguments, result) in SIGNATURES.items():
                function = getattr(dll, name)
                function.argtypes, function.restype = arguments, result
            log.info("loaded %s", path)
            self._dll = dll
        return self._dll

    def open(self, card_id: int) -> tuple[int, int | None]:
        handle = wintypes.HANDLE()
        rc = int(self._load().DA6401_JC_OpenDev(byref(handle), c_ubyte(card_id)))
        return rc, (handle.value if rc == 0 else None)

    def close(self, handle: int) -> int:
        return int(self._load().DA6401_JC_CloseDev(wintypes.HANDLE(handle)))

    def reset(self, handle: int) -> int:
        return int(self._load().DA6401_JC_ResetDev(wintypes.HANDLE(handle)))

    def info(self, handle: int) -> tuple[int, dict[str, int]]:
        info = DevParInfo()
        rc = int(self._load().DA6401_JC_GetDevParInfo(wintypes.HANDLE(handle), byref(info)))
        return rc, info.as_dict()

    def create_channel(self, handle: int, channel: int, mode: int) -> int:
        return int(self._load().DA6401_JC_DA_CreateVoltChan(wintypes.HANDLE(handle), c_ubyte(channel), c_ubyte(mode)))

    def write(self, handle: int, channel: int, value: float) -> int:
        return int(self._load().DA6401_JC_DA_WriteVoltage(wintypes.HANDLE(handle), c_ubyte(channel), c_float(value)))
