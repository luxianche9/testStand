# PyInstaller build: stdout must stay available for the desktop protocol.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata

root = Path(SPECPATH)
datas = []
# devkit: the adapter template; pypdfium2_raw: version files beside pdfium.dll.
for package in ("certifi", "jsonschema_specifications", "teststand_backend.mcp_gateway", "teststand_backend.workspace",
                "teststand_backend.devkit", "pypdfium2_raw", "pypdfium2"):
    datas += collect_data_files(package)
datas += copy_metadata("ada-url")
# No adapter is bundled: device types are installed as .tsdev packages into the user data
# directory. The SDK they import is bundled whole, with its metadata (packages check its version).
datas += copy_metadata("teststand-device-sdk")
datas += copy_metadata("teststand-backend")  # __version__ reads it
binaries = collect_dynamic_libs("pypdfium2_raw")  # PDFium renders manual pages for OCR (devkit)
hiddenimports = [
    "anyio._backends._asyncio", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on", "sqlite3", "cryptography", "pydantic_core",
    "ada_url._ada_wrapper", "_cffi_backend",
]
hiddenimports += collect_submodules("teststand_backend")
hiddenimports += collect_submodules("teststand_device_sdk")
# The devkit runs the tests of adapters the agent writes with pytest, in the frozen backend too.
import pytest  # noqa: E402

hiddenimports += list(pytest.freeze_includes()) + collect_submodules("pypdf") + collect_submodules("pypdfium2")
hiddenimports += ["pypdfium2_raw", "pypdfium2_cfg"] + collect_submodules("winrt")  # OCR (devkit)
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
