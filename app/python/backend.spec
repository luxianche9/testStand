# PyInstaller build: stdout must stay available for the desktop protocol.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH)
datas = []
for package in ("certifi", "jsonschema_specifications", "teststand_backend.mcp_gateway", "teststand_backend.workspace"):
    datas += collect_data_files(package)
datas += copy_metadata("ada-url")
# No adapter is bundled: device types are installed as .tsdev packages into the user data
# directory. The SDK they import is bundled whole, with its metadata (packages check its version).
datas += copy_metadata("teststand-device-sdk")
datas += copy_metadata("teststand-backend")  # __version__ reads it
binaries = []
hiddenimports = [
    "anyio._backends._asyncio", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on", "sqlite3", "cryptography", "pydantic_core",
    "ada_url._ada_wrapper", "_cffi_backend",
]
hiddenimports += collect_submodules("teststand_backend")
hiddenimports += collect_submodules("teststand_device_sdk")
# Adapters may use any standard-library module; PyInstaller only bundles the ones it sees imported.
hiddenimports += [
    "ctypes", "ctypes.wintypes", "winreg", "socket", "select", "struct", "queue", "statistics", "csv",
    "zipfile", "tomllib", "xml.etree.ElementTree",
]
a = Analysis(
    [str(root / "scripts/frozen_entry.py")], pathex=[str(root / "src")], binaries=binaries,
    datas=datas, hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[], excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="teststand-backend", debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="teststand-backend")
