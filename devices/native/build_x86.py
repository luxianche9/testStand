"""Build the 32-bit bridges with MSVC and place each in its adapter package.

    python devices/native/build_x86.py

For vendor drivers that only ship a 32-bit DLL (the 64-bit backend cannot load them). Compiles
``hwcli_<card>.cpp`` with the MSVC x86 toolset (``/MT``, so the exe needs no VC++ runtime); the
vendor DLL is loaded at run time, so nothing vendor-specific is linked. Visual Studio is found with
``vswhere``; ``--vcvars`` points at ``vcvarsall.bat`` directly. Each exe is written to
``adapters/<card>/src/teststand_adapter_<card>/bin/``, where the adapter looks for it first.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTERS = HERE.parent / "adapters"
BRIDGES = ("lj_co8",)
FLAGS = ["/nologo", "/std:c++17", "/O2", "/EHsc", "/MT", "/W4", "/utf-8", "/DNOMINMAX"]
VSWHERE = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio" / \
    "Installer" / "vswhere.exe"


def vcvarsall(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    if not VSWHERE.is_file():
        sys.exit("vswhere.exe not found: install Visual Studio with the C++ workload or pass --vcvars")
    found = subprocess.run([str(VSWHERE), "-latest", "-products", "*", "-requires",
                            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
                           capture_output=True, text=True, check=True).stdout.strip()
    if not found:
        sys.exit("No Visual Studio with the C++ x86/x64 tools found: pass --vcvars")
    return Path(found) / "VC" / "Auxiliary" / "Build" / "vcvarsall.bat"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--vcvars")
    args = parser.parse_args()
    vcvars = vcvarsall(args.vcvars)
    # vcvarsall calls vswhere itself and complains when it is not on PATH.
    env = {**os.environ, "PATH": f"{os.environ.get('PATH', '')};{VSWHERE.parent}"}
    for card in BRIDGES:
        target = ADAPTERS / card / "src" / f"teststand_adapter_{card}" / "bin" / f"hwcli_{card}.exe"
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as objects:
            compile_line = subprocess.list2cmdline(
                ["cl", *FLAGS, f"/I{HERE}", f"/Fo{objects}\\", f"/Fe{target}", str(HERE / f"hwcli_{card}.cpp")])
            command = f'call "{vcvars}" x86 >nul && {compile_line}'
            print(compile_line, flush=True)
            subprocess.run(command, shell=True, check=True, env=env)
    return 0


if __name__ == "__main__":
    sys.exit(main())
