"""ctypes binding of ``JC_SDS48.dll`` (Devices-JC JCXD-SDS48-X driver V2.0.0, x64).

Every function is ``__stdcall`` and returns 0 on success (software manual V2.0.0 §2.2). The
manual's ``JC_SDS48_Get_DevParInfo`` is used: the header's ``JC_SDS48_GetDevParInfo`` fills the
same structure but returns 1 on this driver. The x64 DLL ships in ``bin/``; the kernel driver
``JC_SDS48`` must be installed on the PC.
"""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import POINTER, byref, c_int, c_ubyte, wintypes
from pathlib import Path
from typing import Any

from teststand_device_sdk import DEVICE_UNREACHABLE, DeviceError

log = logging.getLogger(__name__)

PACKAGED_DLL = Path(__file__).resolve().parent / "bin" / "JC_SDS48.dll"
MAX_CARDS = 8


class DevParInfo(ctypes.Structure):
    _fields_ = [(name, wintypes.DWORD) for name in
                ("dwCardType", "dwhwVersion", "dwdvrVersion", "dwlibVersion", "dwBoardID", "dwSN", "dwChMax")]

    def as_dict(self) -> dict[str, int]:
        return {"cardType": self.dwCardType, "hwVersion": self.dwhwVersion, "driverVersion": self.dwdvrVersion,
                "libVersion": self.dwlibVersion, "boardId": self.dwBoardID, "serialNumber": self.dwSN,
                "channelMax": self.dwChMax}


H = wintypes.HANDLE
SIGNATURES: dict[str, list[Any]] = {
    "OpenDev": [POINTER(H), c_ubyte],
    "CloseDev": [H],
    "ResetDev": [H],
    "Get_DevParInfo": [H, POINTER(DevParInfo)],
    "GetDevSn": [H, POINTER(wintypes.DWORD)],
    "Switch_SetMultiStatus": [H, POINTER(wintypes.DWORD)],
    "Switch_GetMultiStatus": [H, POINTER(wintypes.DWORD)],
    "Switch_GetSingleStatus": [H, c_ubyte, POINTER(c_ubyte)],
}


def resolve_dll(explicit: str | None) -> Path:
    for candidate in (explicit, os.environ.get("JC_SDS48_DLL"), str(PACKAGED_DLL)):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise DeviceError("JC_SDS48.dll not found; set settings.dllPath", category=DEVICE_UNREACHABLE)


class Sds48Driver:
    """Raw vendor calls; the DLL loads on first use."""

    def __init__(self, dll_path: str | None = None) -> None:
        self.dll_path = dll_path
        self._dll: Any = None

    def _fn(self, name: str) -> Any:
        if self._dll is None:
            path = resolve_dll(self.dll_path)
            try:
                dll = ctypes.WinDLL(str(path))  # type: ignore[attr-defined]
            except OSError as exc:
                raise DeviceError(f"cannot load {path}: {exc}", category=DEVICE_UNREACHABLE) from exc
            for short, arguments in SIGNATURES.items():
                function = getattr(dll, f"JC_SDS48_{short}")
                function.argtypes, function.restype = arguments, c_int
            log.info("loaded %s", path)
            self._dll = dll
        return getattr(self._dll, f"JC_SDS48_{name}")

    def open(self, card_id: int) -> tuple[int, int | None]:
        handle = H()
        rc = int(self._fn("OpenDev")(byref(handle), card_id))
        return rc, (handle.value if rc == 0 else None)

    def close(self, h: int) -> int:
        return int(self._fn("CloseDev")(h))

    def reset(self, h: int) -> int:
        return int(self._fn("ResetDev")(h))

    def info(self, h: int) -> tuple[int, dict[str, int]]:
        info = DevParInfo()
        rc = int(self._fn("Get_DevParInfo")(h, byref(info)))
        return rc, info.as_dict()

    def serial(self, h: int) -> tuple[int, int]:
        value = wintypes.DWORD()
        rc = int(self._fn("GetDevSn")(h, byref(value)))
        return rc, int(value.value)

    def set_mask(self, h: int, mask: int) -> int:
        """Bit i = relay i: 1 energized (COM-OP closed), 0 released (COM-CL closed)."""
        words = (wintypes.DWORD * 2)(mask & 0xFFFFFFFF, (mask >> 32) & 0xFFFF)
        return int(self._fn("Switch_SetMultiStatus")(h, words))

    def get_mask(self, h: int) -> tuple[int, int]:
        words = (wintypes.DWORD * 2)()
        rc = int(self._fn("Switch_GetMultiStatus")(h, words))
        return rc, int(words[0]) | (int(words[1]) & 0xFFFF) << 32

    def get_single(self, h: int, channel: int) -> tuple[int, int]:
        status = c_ubyte()
        rc = int(self._fn("Switch_GetSingleStatus")(h, channel, byref(status)))
        return rc, int(status.value)
