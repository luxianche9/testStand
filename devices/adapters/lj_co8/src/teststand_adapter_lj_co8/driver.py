"""Bridge to ``hwcli_lj_co8`` (32-bit JSON-line CLI over PXI4281.dll; source in ``devices/native``).

The vendor driver ``PXI4281.dll`` is a 32-bit LabWindows/CVI instrument driver on NI-VISA, which the
64-bit backend cannot load, so ``devices/native/build_x86.py`` builds a 32-bit bridge into ``bin/``.
The DLL ships next to it in ``bin/``; ``settings.dllPath`` (passed in the ``open`` request)
overrides it. It needs the 32-bit LabWindows/CVI runtime (``cvirte.dll``) and NI-VISA.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from teststand_device_sdk import JsonLineCli, find_executable

EXECUTABLE = "hwcli_lj_co8"
BIN = Path(__file__).resolve().parent / "bin"


def hwcli(settings: Any) -> JsonLineCli:
    path = find_executable(EXECUTABLE, explicit=settings.get("hwcliPath"),
                           env_names=("LJ_CO8_HWCLI_PATH", "HWCLI_PATH"), roots=(BIN,))
    return JsonLineCli(path, name=EXECUTABLE,
                       missing_hint="Build it with python devices/native/build_x86.py, or "
                                    "set settings.hwcliPath or LJ_CO8_HWCLI_PATH.")
