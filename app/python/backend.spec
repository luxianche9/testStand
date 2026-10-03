# PyInstaller build: stdout must stay available for the desktop protocol.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH)
datas = []
for package in ("certifi", "jsonschema_specifications", "teststand_backend.mcp_gateway", "teststand_backend.workspace"):
    datas += collect_data_files(package)
datas += [(str(root / "vendor/icu/LICENSE"), "licenses/icu")]
datas += copy_metadata("ada-url")
# Device plugins are found through their "teststand.devices" entry points (dist metadata).
DEVICE_PACKAGES = {
    "teststand-device-sdk": "teststand_device_sdk",
    "teststand-adapter-pci1710l": "teststand_adapter_pci1710l",
    "teststand-adapter-pci1762": "teststand_adapter_pci1762",
    "teststand-adapter-pci6208v": "teststand_adapter_pci6208v",
    "teststand-adapter-cp118u-i": "teststand_adapter_cp118u_i",
}
for distribution, package in DEVICE_PACKAGES.items():
    datas += copy_metadata(distribution)
    # Package data, including the DAQNavi bridges built into <adapter>/bin/ by devices/native/build.py.
    datas += collect_data_files(package)
binaries = [(str(path), "icu") for path in (root / "vendor/icu/bin64").glob("*.dll")]
hiddenimports = [
    "anyio._backends._asyncio", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on", "sqlite3", "cryptography", "pydantic_core",
    "ada_url._ada_wrapper", "_cffi_backend",
]
hiddenimports += collect_submodules("teststand_backend")
for package in DEVICE_PACKAGES.values():
    hiddenimports += collect_submodules(package)
a = Analysis(
    [str(root / "scripts/frozen_entry.py")], pathex=[str(root / "src")], binaries=binaries,
    datas=datas, hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[], excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="teststand-backend", debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="teststand-backend")
