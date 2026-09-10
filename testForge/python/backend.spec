# PyInstaller build: stdout must stay available for the desktop protocol.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH)
datas = []
for package in ("certifi", "jsonschema_specifications", "testforge_backend.mcp_gateway"):
    datas += collect_data_files(package)
datas += [(str(root / "vendor/icu/LICENSE"), "licenses/icu")]
datas += copy_metadata("ada-url")
binaries = [(str(path), "icu") for path in (root / "vendor/icu/bin64").glob("*.dll")]
hiddenimports = [
    "anyio._backends._asyncio", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on", "sqlite3", "cryptography", "nacl", "pydantic_core",
    "ada_url._ada_wrapper", "_cffi_backend",
]
hiddenimports += collect_submodules("testforge_backend")
a = Analysis(
    [str(root / "scripts/frozen_entry.py")], pathex=[str(root / "src")], binaries=binaries,
    datas=datas, hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[], excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="testforge-backend", debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="testforge-backend")
