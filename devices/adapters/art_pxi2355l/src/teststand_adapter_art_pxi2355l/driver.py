"""ctypes binding of ART-DAQ (``Art_DAQ_64.dll``, NI-DAQmx style API) for the PXI2355L.

The DLL comes with the ART-DAQ installer (System32). Calls return 0 on success, a negative
error or a positive warning; ``last_error`` fetches the driver's extended message.
"""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import POINTER, byref, c_char_p, c_double, c_int32, c_uint32, c_void_p
from typing import Any

from teststand_device_sdk import DEVICE_UNREACHABLE, DeviceError

log = logging.getLogger(__name__)

DEFAULT_DLL = "Art_DAQ_64.dll"
SYSTEM_DEV_NAMES = 0x193B
DEV_PRODUCT_TYPE = 0x0631
DEV_SERIAL_NUM = 0x0632
CHAN_FOR_ALL_LINES = 1
POWER_UP = {10192: "high", 10214: "low", 10310: "input"}

SIGNATURES: dict[str, list[Any]] = {
    "ArtDAQ_GetSystemAttribute": [c_int32, c_char_p, c_uint32],
    "ArtDAQ_GetDeviceAttributeEx": [c_char_p, c_int32, c_void_p, c_int32, c_void_p],
    "ArtDAQ_CreateTask": [c_char_p, POINTER(c_void_p)],
    "ArtDAQ_ClearTask": [c_void_p],
    "ArtDAQ_StartTask": [c_void_p],
    "ArtDAQ_CreateDIChan": [c_void_p, c_char_p, c_char_p, c_int32],
    "ArtDAQ_CreateDOChan": [c_void_p, c_char_p, c_char_p, c_int32],
    "ArtDAQ_ReadDigitalScalarU32": [c_void_p, c_double, POINTER(c_uint32), c_void_p],
    "ArtDAQ_WriteDigitalScalarU32": [c_void_p, c_int32, c_double, c_uint32, c_void_p],
    "ArtDAQ_GetDigitalPowerUpStates": [c_char_p, c_char_p, POINTER(c_int32), c_uint32],
    "ArtDAQ_GetExtendedErrorInfo": [c_char_p, c_uint32],
}


class ArtDaqDriver:
    """Two persistent tasks per card: DI on ports 0-3 and DO on ports 4-7 (32 lines each)."""

    def __init__(self, dll_path: str | None = None) -> None:
        self.dll_path = dll_path or os.environ.get("ART_DAQ_DLL") or DEFAULT_DLL
        self._dll: Any = None

    def _fn(self, name: str) -> Any:
        if self._dll is None:
            try:
                dll = ctypes.WinDLL(self.dll_path)  # type: ignore[attr-defined]
            except OSError as exc:
                raise DeviceError(f"cannot load {self.dll_path} (is ART-DAQ installed?): {exc}",
                                  category=DEVICE_UNREACHABLE) from exc
            for function_name, arguments in SIGNATURES.items():
                function = getattr(dll, function_name)
                function.argtypes, function.restype = arguments, c_int32
            log.info("loaded %s", self.dll_path)
            self._dll = dll
        return getattr(self._dll, name)

    def last_error(self) -> str:
        buffer = ctypes.create_string_buffer(2048)
        self._fn("ArtDAQ_GetExtendedErrorInfo")(buffer, 2048)
        return buffer.value.decode("gbk", "replace").strip()

    def devices(self) -> list[str]:
        buffer = ctypes.create_string_buffer(4096)
        rc = int(self._fn("ArtDAQ_GetSystemAttribute")(SYSTEM_DEV_NAMES, buffer, 4096))
        if rc < 0:
            return []
        return [name.strip() for name in buffer.value.decode(errors="replace").split(",") if name.strip()]

    def identity(self, device: str) -> dict[str, Any]:
        product = ctypes.create_string_buffer(256)
        serial = c_uint32()
        rc1 = int(self._fn("ArtDAQ_GetDeviceAttributeEx")(device.encode(), DEV_PRODUCT_TYPE, product, 256, None))
        rc2 = int(self._fn("ArtDAQ_GetDeviceAttributeEx")(device.encode(), DEV_SERIAL_NUM, byref(serial), 4, None))
        return {"device": device, "productType": product.value.decode(errors="replace"), "serialNumber": serial.value,
                "rc": min(rc1, rc2)}

    def create(self, device: str, output: bool) -> tuple[int, int | None]:
        task = c_void_p()
        rc = int(self._fn("ArtDAQ_CreateTask")(b"", byref(task)))
        if rc < 0:
            return rc, None
        lines = f"{device}/port{'4:7' if output else '0:3'}".encode()
        create = "ArtDAQ_CreateDOChan" if output else "ArtDAQ_CreateDIChan"
        rc = int(self._fn(create)(task, lines, b"", CHAN_FOR_ALL_LINES))
        if rc >= 0:
            rc = int(self._fn("ArtDAQ_StartTask")(task))
        if rc < 0:
            self._fn("ArtDAQ_ClearTask")(task)
            return rc, None
        return rc, task.value

    def clear(self, task: int) -> int:
        return int(self._fn("ArtDAQ_ClearTask")(task))

    def read(self, task: int) -> tuple[int, int]:
        """DI task: input levels; DO task: the output state the driver holds (bit i = line i)."""
        value = c_uint32()
        rc = int(self._fn("ArtDAQ_ReadDigitalScalarU32")(task, 1.0, byref(value), None))
        return rc, int(value.value)

    def write(self, task: int, mask: int) -> int:
        return int(self._fn("ArtDAQ_WriteDigitalScalarU32")(task, 1, 1.0, mask & 0xFFFFFFFF, None))

    def power_up(self, device: str) -> tuple[int, list[str]]:
        states = (c_int32 * 32)()
        rc = int(self._fn("ArtDAQ_GetDigitalPowerUpStates")(device.encode(), f"{device}/port4:7".encode(), states, 32))
        return rc, [POWER_UP.get(int(state), str(int(state))) for state in states]
