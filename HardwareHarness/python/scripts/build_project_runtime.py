"""Build the standalone SDK wheel and offline Windows project Python runtime."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from hardwareharness_backend.workspace.environment import PROJECT_DEPENDENCIES, PROJECT_TOML

SDK_VERSION = "0.1.0"
PYTHON_VERSION = "3.11.15"
UV_VERSION = "0.11.32"


def sdk_wheel(root: Path, destination: Path) -> Path:
    """A pure-Python zero-dependency wheel; RECORD covers each exact packaged byte."""
    source = root / "src/hardwareharness"
    if not (source / "__init__.py").is_file():
        raise RuntimeError("hardwareharness SDK source is missing")
    destination.mkdir(parents=True, exist_ok=True)
    wheel = destination / f"hardwareharness-{SDK_VERSION}-py3-none-any.whl"
    metadata = f"hardwareharness-{SDK_VERSION}.dist-info"
    files: dict[str, bytes] = {
        path.relative_to(root / "src").as_posix(): path.read_bytes()
        for path in sorted(source.rglob("*"))
        if path.is_file() and (path.suffix == ".py" or path.name == "py.typed")
    }
    files[f"{metadata}/METADATA"] = (
        "Metadata-Version: 2.3\nName: hardwareharness\n"
        f"Version: {SDK_VERSION}\nSummary: HardwareHarness hardware and structured logging SDK\n"
        "Requires-Python: >=3.11,<3.12\n\n"
    ).encode()
    files[f"{metadata}/WHEEL"] = (
        b"Wheel-Version: 1.0\nGenerator: hardwareharness\n"
        b"Root-Is-Purelib: true\nTag: py3-none-any\n"
    )
    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for name, data in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        writer.writerow([name, f"sha256={digest}", len(data)])
    writer.writerow([f"{metadata}/RECORD", "", ""])
    files[f"{metadata}/RECORD"] = record.getvalue().encode()
    temporary = wheel.with_suffix(".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    os.replace(temporary, wheel)
    return wheel


def command(arguments: list[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        arguments, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout or f"Command failed: {arguments[0]}")
    return result.stdout.strip()


def build(root: Path, destination: Path) -> None:
    destination = destination.resolve()
    if os.name != "nt":
        raise RuntimeError("Build the Windows project runtime on Windows x64")
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("uv is required")
    actual_uv = command([uv, "--version"]).split()[1]
    if actual_uv != UV_VERSION:
        raise RuntimeError(f"Use uv {UV_VERSION}; found {actual_uv}")
    destination.mkdir(parents=True, exist_ok=True)
    command([uv, "python", "install", PYTHON_VERSION])
    python = Path(
        command(
            [uv, "python", "find", "--no-project", "--system", "--managed-python", PYTHON_VERSION]
        )
    )
    if not python.is_file():
        raise RuntimeError("Managed Python installation did not provide an executable")
    base = Path(command([str(python), "-c", "import sys; print(sys.base_prefix)"]))
    if python.resolve().parent != base.resolve() or not (base / "Lib/os.py").is_file():
        raise RuntimeError("Expected a complete standalone CPython installation, not a venv shim")
    shutil.copytree(python.resolve().parent, destination / "python", dirs_exist_ok=True)
    shutil.copy2(uv, destination / "uv.exe")
    wheels = destination / "wheels"
    wheel = sdk_wheel(root, root / "dist/sdk")
    wheels.mkdir(exist_ok=True)
    shutil.copy2(wheel, wheels / wheel.name)
    command(
        [
            uv,
            "run",
            "--no-project",
            "--python",
            str(python),
            "--with",
            "pip==26.0.1",
            "python",
            "-m",
            "pip",
            "download",
            "--only-binary=:all:",
            "--dest",
            str(wheels),
            "--find-links",
            str(wheels),
            *PROJECT_DEPENDENCIES,
        ]
    )
    with tempfile.TemporaryDirectory(prefix="hh-runtime-lock-") as temporary:
        project = Path(temporary)
        (project / "pyproject.toml").write_text(PROJECT_TOML, encoding="utf-8", newline="\n")
        command(
            [
                uv,
                "lock",
                "--python",
                str(python),
                "--offline",
                "--no-index",
                "--find-links",
                str(wheels),
            ],
            cwd=project,
        )
        lock = (project / "uv.lock").read_text(encoding="utf-8")
        # Relocatable local wheel paths: the runtime environment regenerates the lock at first sync.
        (destination / "default-uv.lock").write_text(lock, encoding="utf-8", newline="\n")
    manifest = {
        "python": PYTHON_VERSION,
        "uv": UV_VERSION,
        "sdk": SDK_VERSION,
        "dependencies": list(PROJECT_DEPENDENCIES),
        "files": {
            path.relative_to(destination).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(destination.rglob("*"))
            if path.is_file() and path.name != "manifest.json"
        },
    }
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-only", action="store_true")
    parser.add_argument("--destination", type=Path)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if arguments.sdk_only:
        print(sdk_wheel(root, root / "dist/sdk"))
    else:
        build(root, arguments.destination or root / "dist/project-runtime-v1")


if __name__ == "__main__":
    main()
