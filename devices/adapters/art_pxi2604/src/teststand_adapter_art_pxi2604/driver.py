"""ctypes binding of ART-SWITCH (``artSwitch_64.dll``, IVI-Switch style) for the PXI2604.

The DLL comes with the ART-SWITCH installer. Status codes: 0 success, negative error, positive
warning. ``artSwitch_GetChannelName`` is never called: it crashes this driver (access violation).
Relays are named ``k0``..``k39``; position 10 = open, 11 = closed; RelayControl 20 opens, 21 closes.
"""

from __future__ import annotations

import ctypes
import logging
import os
from ctypes import POINTER, byref, c_char_p, c_int32, c_uint16, c_uint32
from pathlib import Path
from typing import Any

from teststand_device_sdk import DEVICE_UNREACHABLE, DeviceError

log = logging.getLogger(__name__)

DEFAULT_DLL = r"C:\Program Files (x86)\ART Technology\ART-SWITCH\Lib\x64\artSwitch_64.dll"
TOPOLOGY = b"2604/40-SPDT"
OPEN, CLOSED = 10, 11
OPEN_RELAY, CLOSE_RELAY = 20, 21
ATTR_INSTRUMENT_MODEL = 1_000_000 + 50_000 + 512
ATTR_SERIAL_NUMBER = 1_000_000 + 150_000 + 15

ViSession = c_uint32
SIGNATURES: dict[str, list[Any]] = {
    "artSwitch_InitWithTopology": [c_char_p, c_char_p, c_uint16, c_uint16, POINTER(ViSession)],
    "artSwitch_close": [ViSession],
    "artSwitch_GetError": [ViSession, POINTER(c_int32), c_int32, c_char_p],
    "artSwitch_revision_query": [ViSession, c_char_p, c_char_p],
    "artSwitch_GetAttributeViString": [ViSession, c_char_p, c_uint32, c_int32, c_char_p],
    "artSwitch_GetRelayName": [ViSession, c_int32, c_int32, c_char_p],
    "artSwitch_GetRelayPosition": [ViSession, c_char_p, POINTER(c_int32)],
    "artSwitch_GetRelayCount": [ViSession, c_char_p, POINTER(c_int32)],
    "artSwitch_RelayControl": [ViSession, c_char_p, c_int32],
    "artSwitch_WaitForDebounce": [ViSession, c_int32],
}


def resolve_dll(explicit: str | None) -> str:
    for candidate in (explicit, os.environ.get("ART_SWITCH_DLL"), DEFAULT_DLL):
        if candidate and Path(candidate).is_file():
            return candidate
    raise DeviceError("artSwitch_64.dll not found; install ART-SWITCH or set settings.dllPath",
                      category=DEVICE_UNREACHABLE)


class ArtSwitchDriver:
    def __init__(self, dll_path: str | None = None) -> None:
        self.dll_path = dll_path
        self._dll: Any = None

    def _fn(self, name: str) -> Any:
        if self._dll is None:
            path = resolve_dll(self.dll_path)
            try:
                dll = ctypes.WinDLL(path)  # type: ignore[attr-defined]
            except OSError as exc:
                raise DeviceError(f"cannot load {path}: {exc}", category=DEVICE_UNREACHABLE) from exc
            for function_name, arguments in SIGNATURES.items():
                function = getattr(dll, function_name)
                function.argtypes, function.restype = arguments, c_int32
            log.info("loaded %s", path)
            self._dll = dll
        return getattr(self._dll, name)

    def open(self, resource: str) -> tuple[int, int]:
        vi = ViSession()
        rc = int(self._fn("artSwitch_InitWithTopology")(resource.encode(), TOPOLOGY, 0, 0, byref(vi)))
        return rc, int(vi.value)

    def close(self, vi: int) -> int:
        return int(self._fn("artSwitch_close")(vi))

    def error(self, vi: int) -> str:
        code = c_int32()
        buffer = ctypes.create_string_buffer(512)
        self._fn("artSwitch_GetError")(vi, byref(code), 512, buffer)
        return buffer.value.decode("gbk", "replace").strip()

    def identity(self, vi: int) -> dict[str, str]:
        driver, firmware = ctypes.create_string_buffer(256), ctypes.create_string_buffer(256)
        self._fn("artSwitch_revision_query")(vi, driver, firmware)
        values = {}
        for key, attribute in (("model", ATTR_INSTRUMENT_MODEL), ("serialNumber", ATTR_SERIAL_NUMBER)):
            buffer = ctypes.create_string_buffer(256)
            rc = int(self._fn("artSwitch_GetAttributeViString")(vi, b"", attribute, 256, buffer))
            values[key] = buffer.value.decode(errors="replace") if rc >= 0 else ""
        return {**values, "driverRevision": driver.value.decode(errors="replace"),
                "firmwareRevision": firmware.value.decode(errors="replace")}

    def relay_names(self, vi: int, limit: int = 64) -> list[str]:
        names = []
        for index in range(1, limit + 1):
            buffer = ctypes.create_string_buffer(64)
            if int(self._fn("artSwitch_GetRelayName")(vi, index, 64, buffer)) != 0:
                break
            names.append(buffer.value.decode())
        return names

    def position(self, vi: int, relay: str) -> tuple[int, int]:
        value = c_int32()
        rc = int(self._fn("artSwitch_GetRelayPosition")(vi, relay.encode(), byref(value)))
        return rc, int(value.value)

    def count(self, vi: int, relay: str) -> tuple[int, int]:
        value = c_int32()
        rc = int(self._fn("artSwitch_GetRelayCount")(vi, relay.encode(), byref(value)))
        return rc, int(value.value)

    def control(self, vi: int, relays: list[str], close: bool) -> int:
        return int(self._fn("artSwitch_RelayControl")(vi, ",".join(relays).encode(),
                                                      CLOSE_RELAY if close else OPEN_RELAY))

    def debounce(self, vi: int, max_ms: int) -> int:
        return int(self._fn("artSwitch_WaitForDebounce")(vi, max_ms))
