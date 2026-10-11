"""ctypes binding of ``UMADX3210_x64.dll`` (Devices-JC JCXD-MADS-X-3210 driver, x64).

Every function is ``__stdcall`` and returns 0 on success (software manual V1.0.0 §2.3). The x64 DLL
ships in this package (``bin/``); the kernel driver ``UMADX3210`` must be installed on the PC.
The binding wraps calls and returns raw codes; the adapter decides what a code means.
"""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import POINTER, Structure, byref, c_float, c_int, c_ubyte, wintypes
from pathlib import Path
from typing import Any

from teststand_device_sdk import DEVICE_UNREACHABLE, DeviceError

log = logging.getLogger(__name__)

PACKAGED_DLL = Path(__file__).resolve().parent / "bin" / "UMADX3210_x64.dll"
MAX_CARDS = 8
READ_CHUNK = 1 << 20
"""Largest AD_Read in words; the interrupt-mode software buffer holds 1M words."""


class DevParInfo(Structure):
    _fields_ = [(name, wintypes.DWORD) for name in
                ("dwCardType", "dwhwVersion", "dwdvrVersion", "dwlibVersion", "dwBoardID", "dwSN", "dwChMax")]

    def as_dict(self) -> dict[str, int]:
        return {"cardType": self.dwCardType, "hwVersion": self.dwhwVersion, "driverVersion": self.dwdvrVersion,
                "libVersion": self.dwlibVersion, "boardId": self.dwBoardID, "serialNumber": self.dwSN,
                "channelMax": self.dwChMax}


class AdChannel(Structure):
    _fields_ = [("Channel", c_ubyte), ("InputMode", c_ubyte)]


H = wintypes.HANDLE
U8 = c_ubyte
DW = wintypes.DWORD
SIGNATURES: dict[str, list[Any]] = {
    "OpenDev": [POINTER(H), U8],
    "CloseDev": [H],
    "ResetDev": [H],
    "Get_DevParInfo": [H, POINTER(DevParInfo)],
    "AD_CreateChan": [H, POINTER(AdChannel), U8],
    "AD_CfgSampParam": [H, U8, c_float, U8, U8],
    "AD_SetInt": [H, wintypes.BOOL, wintypes.WORD],
    "AD_StartEx": [H],
    "AD_StopEx": [H],
    "AD_GetFIFOCount": [H, POINTER(DW)],
    "AD_Read": [H, DW, POINTER(DW), POINTER(DW), DW],
    "AD_ConvertVolt": [wintypes.WORD, POINTER(c_float)],
    "DA_CreateVoltChan": [H, U8, U8],
    "DA_WriteVoltage": [H, U8, c_float],
    "DA_CreateWaveChan": [H, U8, c_int, c_float, c_float, c_float, c_float],
    "DA_StartWave": [H, U8],
    "DA_StopWave": [H, U8],
    "IO_CreateDIChan": [H, U8],
    "IO_ReadDIChan": [H, U8, POINTER(U8)],
    "IO_CreateDOChan": [H, U8],
    "IO_WriteDOChan": [H, U8, U8],
    "IO_GetDOChanStatus": [H, U8, POINTER(U8)],
    "CT_CreateFreqChan": [H, U8, U8],
    "CT_CreatePulseCntChan": [H, U8],
    "CT_CreatePulseOutChan": [H, U8, c_float, c_float],
    "CT_WritePulseOut": [H, U8, c_float, c_float],
    "CT_Start": [H, U8],
    "CT_Stop": [H, U8],
    "CT_ReadPulseCnt": [H, U8, POINTER(DW)],
    "CT_ReadFreq": [H, U8, wintypes.WORD, POINTER(c_float), POINTER(wintypes.WORD)],
}


def resolve_dll(explicit: str | None) -> Path:
    for candidate in (explicit, os.environ.get("UMADX3210_DLL"), str(PACKAGED_DLL)):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise DeviceError("UMADX3210_x64.dll not found; set settings.dllPath", category=DEVICE_UNREACHABLE)


class Mads3210Driver:
    """Raw vendor calls; the DLL loads on first use, so constructing this touches nothing."""

    def __init__(self, dll_path: str | None = None) -> None:
        self.dll_path = dll_path
        self._dll: Any = None
        self._buffer = (DW * READ_CHUNK)()

    def _fn(self, name: str) -> Any:
        if self._dll is None:
            path = resolve_dll(self.dll_path)
            try:
                dll = ctypes.WinDLL(str(path))  # type: ignore[attr-defined]
            except OSError as exc:
                raise DeviceError(f"cannot load {path}: {exc}", category=DEVICE_UNREACHABLE) from exc
            for short, arguments in SIGNATURES.items():
                function = getattr(dll, f"UMADX3210_{short}")
                function.argtypes, function.restype = arguments, c_int
            log.info("loaded %s", path)
            self._dll = dll
        return getattr(self._dll, f"UMADX3210_{name}")

    # --- card ---
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

    # --- analog input ---
    def ad_create(self, h: int, channels: list[int], mode: int) -> int:
        table = (AdChannel * len(channels))(*[AdChannel(channel, mode) for channel in channels])
        return int(self._fn("AD_CreateChan")(h, table, len(channels)))

    def ad_configure(self, h: int, aggregate_rate: float, depth: int) -> int:
        """Internal clock, continuous mode; ``aggregate_rate`` is words per second over all channels and
        ``depth`` the words per driver interrupt (1..8100), i.e. the delivery granularity."""
        rc = int(self._fn("AD_CfgSampParam")(h, 0, aggregate_rate, 1, 0))
        return rc or int(self._fn("AD_SetInt")(h, True, depth))

    def ad_start(self, h: int) -> int:
        return int(self._fn("AD_StartEx")(h))

    def ad_stop(self, h: int) -> int:
        return int(self._fn("AD_StopEx")(h))

    def ad_read(self, h: int, frame: int) -> tuple[int, list[int]]:
        """Read every whole frame waiting in the buffer (``frame`` words per frame)."""
        count = DW()
        rc = int(self._fn("AD_GetFIFOCount")(h, byref(count)))
        if rc != 0:
            return rc, []
        want = min(count.value, READ_CHUNK) // frame * frame
        if want == 0:
            return 0, []
        real = DW()
        rc = int(self._fn("AD_Read")(h, want, self._buffer, byref(real), 100))
        return rc, list(self._buffer[: real.value])

    def convert(self, code: int) -> float:
        volts = c_float()
        self._fn("AD_ConvertVolt")(code & 0xFFFF, byref(volts))
        return float(volts.value)

    # --- analog output ---
    def da_create(self, h: int, channel: int) -> int:
        return int(self._fn("DA_CreateVoltChan")(h, channel, 0))

    def da_write(self, h: int, channel: int, volts: float) -> int:
        return int(self._fn("DA_WriteVoltage")(h, channel, volts))

    def da_wave(self, h: int, channel: int, shape: int, amplitude: float, freq: float, phase: float,
                offset: float) -> int:
        rc = int(self._fn("DA_CreateWaveChan")(h, channel, shape, amplitude, freq, phase, offset))
        return rc or int(self._fn("DA_StartWave")(h, channel))

    def da_stop_wave(self, h: int, channel: int) -> int:
        return int(self._fn("DA_StopWave")(h, channel))

    # --- digital I/O ---
    def di_create(self, h: int, channel: int) -> int:
        return int(self._fn("IO_CreateDIChan")(h, channel))

    def do_create(self, h: int, channel: int) -> int:
        return int(self._fn("IO_CreateDOChan")(h, channel))

    def di_read(self, h: int, channel: int) -> tuple[int, int]:
        status = U8()
        rc = int(self._fn("IO_ReadDIChan")(h, channel, byref(status)))
        return rc, int(status.value)

    def do_write(self, h: int, channel: int, level: int) -> int:
        return int(self._fn("IO_WriteDOChan")(h, channel, level))

    def do_status(self, h: int, channel: int) -> tuple[int, int]:
        status = U8()
        rc = int(self._fn("IO_GetDOChanStatus")(h, channel, byref(status)))
        return rc, int(status.value)

    # --- counters ---
    def ct_frequency(self, h: int, channel: int) -> int:
        rc = int(self._fn("CT_CreateFreqChan")(h, channel, 0))
        return rc or int(self._fn("CT_Start")(h, channel))

    def ct_count(self, h: int, channel: int) -> int:
        rc = int(self._fn("CT_CreatePulseCntChan")(h, channel))
        return rc or int(self._fn("CT_Start")(h, channel))

    def ct_pwm(self, h: int, channel: int, freq: float, duty: float) -> int:
        rc = int(self._fn("CT_CreatePulseOutChan")(h, channel, freq, duty))
        return rc or int(self._fn("CT_Start")(h, channel))

    def ct_pwm_update(self, h: int, channel: int, freq: float, duty: float) -> int:
        return int(self._fn("CT_WritePulseOut")(h, channel, freq, duty))

    def ct_stop(self, h: int, channel: int) -> int:
        return int(self._fn("CT_Stop")(h, channel))

    def ct_read_count(self, h: int, channel: int) -> tuple[int, int]:
        value = DW()
        rc = int(self._fn("CT_ReadPulseCnt")(h, channel, byref(value)))
        return rc, int(value.value)

    def ct_read_frequency(self, h: int, channel: int) -> tuple[int, list[float]]:
        data = (c_float * 1023)()
        real = wintypes.WORD()
        rc = int(self._fn("CT_ReadFreq")(h, channel, 1023, data, byref(real)))
        return rc, [float(value) for value in data[: real.value]]
