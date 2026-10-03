"""Build the DAQNavi bridges and place each in its adapter package.

    python devices/native/build.py [--gxx PATH] [--daqnavi DIR]

Compiles ``hwcli_pci1710l.cpp`` and ``hwcli_pci1762.cpp`` with MinGW-w64 ``g++`` (64-bit,
statically linked, so the exe needs no MinGW runtime) against the DAQNavi SDK header
``bdaqctrl.h``; the header loads ``biodaq.dll`` at run time, so nothing is linked from DAQNavi.
Each exe is written to ``adapters/<card>/src/teststand_adapter_<card>/bin/``, where the adapter looks
for it first. ``g++`` is taken from ``--gxx``, ``$GXX`` or ``PATH``; the SDK from ``--daqnavi``,
``$DAQNAVI_ROOT`` or ``C:\\Advantech\\DAQNavi``.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTERS = HERE.parent / "adapters"
BRIDGES = ("pci1710l", "pci1762")
FLAGS = ["-std=c++17", "-O2", "-Wall", "-Wextra", "-Wno-cast-function-type", "-static"]


def compiler(explicit: str | None) -> str:
    found = explicit or os.environ.get("GXX") or shutil.which("g++")
    if not found:
        sys.exit("g++ (MinGW-w64) not found: pass --gxx or set GXX")
    return found


def daqnavi(explicit: str | None) -> Path:
    root = Path(explicit or os.environ.get("DAQNAVI_ROOT") or r"C:\Advantech\DAQNavi")
    if not (root / "Inc" / "bdaqctrl.h").is_file():
        sys.exit(f"DAQNavi SDK not found at {root} (expected Inc/bdaqctrl.h): pass --daqnavi or set DAQNAVI_ROOT")
    return root


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--gxx")
    parser.add_argument("--daqnavi")
    args = parser.parse_args()
    gxx, sdk = compiler(args.gxx), daqnavi(args.daqnavi)
    for card in BRIDGES:
        target = ADAPTERS / card / "src" / f"teststand_adapter_{card}" / "bin" / f"hwcli_{card}.exe"
        target.parent.mkdir(parents=True, exist_ok=True)
        command = [gxx, *FLAGS, f"-I{HERE}", f"-I{sdk / 'Inc'}", "-o", str(target), str(HERE / f"hwcli_{card}.cpp")]
        print(" ".join(command), flush=True)
        subprocess.run(command, check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
