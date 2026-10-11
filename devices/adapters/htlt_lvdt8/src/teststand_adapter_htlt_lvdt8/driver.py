"""ctypes binding of the HTLT LVDT SDK (``htlt_api_x64.dll``, SDK 2.x) for the PXI68802W simulator.

Every function returns an ``HTLT_STATUS`` (0 = success; ``STATUS`` names the rest). Boards open by
id (1-based, PCI enumeration order) or by serial number. The x64 DLL ships in ``bin/``; the board
driver from the HTLT 2.x kit must be installed on the PC.
"""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import POINTER, byref, c_char_p, c_float, c_int, c_ubyte, c_uint32, c_void_p
from pathlib import Path
from typing import Any

from teststand_device_sdk import DEVICE_UNREACHABLE, DeviceError

log = logging.getLogger(__name__)

PACKAGED_DLL = Path(__file__).resolve().parent / "bin" / "htlt_api_x64.dll"
STATUS = ("SUCCESS", "OS_ERROR", "LOW_MEMORY", "BAD_PARAMETER_1", "BAD_PARAMETER_2", "BAD_PARAMETER_3",
          "BAD_PARAMETER_4", "BAD_PARAMETER_5", "BAD_PARAMETER_6", "BAD_PARAMETER_7", "BAD_PARAMETER_8",
          "BAD_PARAMETER_9", "NULL_DESCRIPTOR", "NO_BOARD", "NOT_OPEN", "SIGNALED", "INVALID_LOOP_MODE",
          "INVALID_OUTPUT_MODE", "INVALID_MODE", "TRANSMISSION_RATIO_OUT_OF_RANGE",
          "NOT_IN_EXTERNAL_EXCITATION_CONDITION", "CHANNEL_NOT_ENABLE", "BOARD_NOT_FOUND_BY_SN",
          "FREQ_OUT_OF_RANGE", "FUNCTION_NOT_SUPPORT_BY_HW")
"""``HTLT_STATUS`` in enum order (htlt_errno.h)."""

H = c_void_p
U8 = c_ubyte
SIGNATURES: dict[str, list[Any]] = {
    "HTLT_Open": [POINTER(H), U8],
    "HTLT_OpenBySerialNumber": [POINTER(H), c_uint32],
    "HTLT_Close": [POINTER(H)],
    "HTLT_GetSN": [H, POINTER(c_uint32)],
    "HTLT_HwVersion": [H, POINTER(c_uint32)],
    "HTLT_SdkVersion": [H, POINTER(c_char_p)],
    "HTLT_DrvVersion": [H, POINTER(c_char_p)],
    "HTLT_ChannelReset": [H, U8],
    "HTLT_SetEnable": [H, U8, U8],
    "HTLT_SetLvdtMode": [H, U8, U8, U8],
    "HTLT_SetLoopMode": [H, U8, c_int],
    "HTLT_UpdateLvdtChannel": [H, U8, c_float, c_float, c_float],
    "HTLT_SetInternalExc": [H, U8, c_float, c_float, c_float],
    "HTLT_EnableInternalExc": [H, U8, U8],
    "HTLT_ReadExc": [H, U8, POINTER(c_float), POINTER(c_float)],
    "HTLT_ReadLvdtOutput": [H, U8, POINTER(c_float), POINTER(c_float)],
}


def status_name(code: int) -> str:
    return STATUS[code] if 0 <= code < len(STATUS) else f"code {code}"


def resolve_dll(explicit: str | None) -> Path:
    for candidate in (explicit, os.environ.get("HTLT_API_DLL"), str(PACKAGED_DLL)):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise DeviceError("htlt_api_x64.dll not found; set settings.dllPath", category=DEVICE_UNREACHABLE)


class HtltDriver:
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
            for function_name, arguments in SIGNATURES.items():
                function = getattr(dll, function_name)
                function.argtypes, function.restype = arguments, c_int
            log.info("loaded %s", path)
            self._dll = dll
        return getattr(self._dll, name)

    def open(self, board_id: int, serial: int | None) -> tuple[int, int | None]:
        handle = H()
        if serial is not None:
            rc = int(self._fn("HTLT_OpenBySerialNumber")(byref(handle), serial))
        else:
            rc = int(self._fn("HTLT_Open")(byref(handle), board_id))
        return rc, (handle.value if rc == 0 else None)

    def close(self, handle: int) -> int:
        return int(self._fn("HTLT_Close")(byref(H(handle))))

    def identity(self, handle: int) -> dict[str, Any]:
        serial, hardware = c_uint32(), c_uint32()
        sdk, driver = c_char_p(), c_char_p()
        rc = int(self._fn("HTLT_GetSN")(handle, byref(serial)))
        self._fn("HTLT_HwVersion")(handle, byref(hardware))
        self._fn("HTLT_SdkVersion")(handle, byref(sdk))
        self._fn("HTLT_DrvVersion")(handle, byref(driver))
        return {"serialNumber": serial.value, "hwVersion": hardware.value, "snRc": rc,
                "sdkVersion": (sdk.value or b"").decode(errors="replace"),
                "driverVersion": (driver.value or b"").decode(errors="replace")}

    def reset_channel(self, handle: int, channel: int) -> int:
        return int(self._fn("HTLT_ChannelReset")(handle, channel))

    def enable(self, handle: int, channel: int, on: bool) -> int:
        return int(self._fn("HTLT_SetEnable")(handle, channel, int(on)))

    def mode(self, handle: int, channel: int, internal: bool, two_wire: bool) -> int:
        rc = int(self._fn("HTLT_SetLvdtMode")(handle, channel, 0 if internal else 1, int(two_wire)))
        return rc or int(self._fn("HTLT_SetLoopMode")(handle, channel, 0))

    def internal_excitation(self, handle: int, channel: int, volts: float, freq: float, on: bool) -> int:
        rc = int(self._fn("HTLT_SetInternalExc")(handle, channel, volts, freq, 0.0)) if on else 0
        return rc or int(self._fn("HTLT_EnableInternalExc")(handle, channel, int(on)))

    def update(self, handle: int, channel: int, ratio: float, a: float, b: float) -> int:
        return int(self._fn("HTLT_UpdateLvdtChannel")(handle, channel, ratio, a, b))

    def read_excitation(self, handle: int, channel: int) -> tuple[int, float, float]:
        volts, freq = c_float(), c_float()
        rc = int(self._fn("HTLT_ReadExc")(handle, channel, byref(volts), byref(freq)))
        return rc, float(volts.value), float(freq.value)

    def read_output(self, handle: int, channel: int) -> tuple[int, float, float]:
        va, vb = c_float(), c_float()
        rc = int(self._fn("HTLT_ReadLvdtOutput")(handle, channel, byref(va), byref(vb)))
        return rc, float(va.value), float(vb.value)
