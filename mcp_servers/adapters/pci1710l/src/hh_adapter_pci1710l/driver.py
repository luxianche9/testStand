"""Bridge to ``hwcli_pci1710l`` (DAQNavi JSON-line CLI, built from native/)."""

from __future__ import annotations

from typing import Any

from hardwareharness_device_sdk import JsonLineCli, find_executable

EXECUTABLE = "hwcli_pci1710l"


def hwcli(settings: Any) -> JsonLineCli:
    path = find_executable(EXECUTABLE, explicit=settings.get("hwcliPath"),
                           env_names=("PCI1710L_HWCLI_PATH", "HWCLI_PATH"))
    return JsonLineCli(path, name=EXECUTABLE,
                       missing_hint="Build native/ (cmake -S native -B native/build && cmake --build native/build), "
                                    "set settings.hwcliPath or PCI1710L_HWCLI_PATH.")
