# PyInstaller build: stdout must stay available for the desktop protocol.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH)
datas = []
for package in ("certifi", "jsonschema_specifications", "hardwareharness_backend.mcp_gateway", "hardwareharness_backend.workspace"):
    datas += collect_data_files(package)
datas += [(str(root / "vendor/icu/LICENSE"), "licenses/icu")]
datas += copy_metadata("ada-url")
# Device plugins are found through their "hardwareharness.devices" entry points (dist metadata).
DEVICE_PACKAGES = {
    "hardwareharness-device-sdk": "hardwareharness_device_sdk",
    "hh-adapter-pci1710l": "hh_adapter_pci1710l",
    "hh-adapter-pci1762": "hh_adapter_pci1762",
    "hh-adapter-pci6208v": "hh_adapter_pci6208v",
    "hh-adapter-cp118u-i": "hh_adapter_cp118u_i",
}
for distribution in DEVICE_PACKAGES:
    datas += copy_metadata(distribution)
binaries = [(str(path), "icu") for path in (root / "vendor/icu/bin64").glob("*.dll")]
hiddenimports = [
    "anyio._backends._asyncio", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on", "sqlite3", "cryptography", "pydantic_core",
    "ada_url._ada_wrapper", "_cffi_backend",
]
hiddenimports += collect_submodules("hardwareharness_backend")
for package in DEVICE_PACKAGES.values():
    hiddenimports += collect_submodules(package)
a = Analysis(
    [str(root / "scripts/frozen_entry.py")], pathex=[str(root / "src")], binaries=binaries,
    datas=datas, hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[], excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="hardwareharness-backend", debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="hardwareharness-backend")
