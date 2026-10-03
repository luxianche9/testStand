"""Bridge to ``hwcli_pci1710l`` (DAQNavi JSON-line CLI; source in ``mcp_servers/native``, built into ``bin/``)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hardwareharness_device_sdk import JsonLineCli, find_executable

EXECUTABLE = "hwcli_pci1710l"
BIN = Path(__file__).resolve().parent / "bin"


def hwcli(settings: Any) -> JsonLineCli:
    path = find_executable(EXECUTABLE, explicit=settings.get("hwcliPath"),
                           env_names=("PCI1710L_HWCLI_PATH", "HWCLI_PATH"), roots=(BIN,))
    return JsonLineCli(path, name=EXECUTABLE,
                       missing_hint="Build it with python mcp_servers/native/build.py, or "
                                    "set settings.hwcliPath or PCI1710L_HWCLI_PATH.")
