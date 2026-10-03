"""Build ``.tsdev`` device packages from the adapters in this workspace.

    python devices/pack.py pci1762 [pci6208v ...] | --all  [--out DIR] [--skip-tests]

For each adapter: run its tests and the dry-run ``--check`` compliance suite (``test.ps1``),
make sure the files listed under ``[tool.teststand.package] requiredFiles`` exist (the DAQNavi
bridges built by ``native/build.py``), build its wheel, add wheels for any third-party
dependencies (CPython 3.11, 64-bit Windows), and write ``<out>/<type>-<version>.tsdev``:
``package.json`` (the manifest testStand shows before installing) plus ``wheels/*.whl``.
Install a package on the testStand Devices page; testStand itself is not rebuilt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTERS = HERE / "adapters"
SDK = "teststand-device-sdk"
GROUP = "teststand.devices"


def run(command: list[str], **options: object) -> subprocess.CompletedProcess[str]:
    print("  $ " + " ".join(command), flush=True)
    return subprocess.run(command, check=True, text=True, cwd=HERE, **options)  # type: ignore[call-overload]


def project(adapter: str) -> dict:
    path = ADAPTERS / adapter / "pyproject.toml"
    if not path.is_file():
        sys.exit(f"Unknown adapter {adapter!r}: {path} not found")
    return tomllib.loads(path.read_text(encoding="utf-8"))


def describe(device_type: str) -> dict:
    """Manufacturer, model, isolation and description, read from the adapter class itself."""
    script = (
        "import json,sys; from teststand_device_sdk import load_device; d=load_device(sys.argv[1]); "
        "print(json.dumps({'manufacturer': d.manufacturer, 'model': d.model, "
        "'isolation': d.isolation, 'description': d.description}))"
    )
    output = run(["uv", "run", "python", "-c", script, device_type], capture_output=True).stdout
    return json.loads(output.strip().splitlines()[-1])


def dependencies(meta: dict) -> list[str]:
    return [item for item in meta["project"].get("dependencies", []) if not item.lower().startswith(SDK)]


def sdk_range(meta: dict) -> str:
    for item in meta["project"].get("dependencies", []):
        if item.lower().startswith(SDK):
            return item[len(SDK):].strip() or ">=0"
    sys.exit("The adapter must depend on teststand-device-sdk")


def third_party_wheels(requirements: list[str], target: Path) -> None:
    """Wheels (no source builds) for the adapter's own dependencies and theirs, for the backend's Python."""
    if not requirements:
        return
    run(["uv", "run", "--with", "pip", "python", "-m", "pip", "download", "--only-binary=:all:",
         "--python-version", "3.11", "--platform", "win_amd64", "--implementation", "cp",
         "--dest", str(target), *requirements])
    for wheel in target.glob("teststand_device_sdk-*.whl"):
        wheel.unlink()  # testStand provides the SDK


def pack(adapter: str, out: Path, skip_tests: bool) -> Path:
    meta = project(adapter)
    points = meta["project"].get("entry-points", {}).get(GROUP, {})
    if len(points) != 1:
        sys.exit(f"{adapter}: declare exactly one [project.entry-points.\"{GROUP}\"] entry")
    [device_type] = points
    options = meta.get("tool", {}).get("teststand", {}).get("package", {})
    package_dir = ADAPTERS / adapter / "src" / f"teststand_adapter_{adapter}"
    missing = [name for name in options.get("requiredFiles", []) if not (package_dir / name).is_file()]
    if missing:
        sys.exit(f"{adapter}: missing {', '.join(missing)} (build them first, e.g. python devices/native/build.py)")
    print(f"== {adapter} ({device_type})", flush=True)
    if not skip_tests:
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(HERE / "test.ps1"),
             "-Target", adapter])
    with tempfile.TemporaryDirectory() as temporary:
        staging = Path(temporary)
        # setuptools reuses build/lib; a stale copy could put deleted modules into the wheel.
        shutil.rmtree(ADAPTERS / adapter / "build", ignore_errors=True)
        run(["uv", "build", "--wheel", "--quiet", "--out-dir", str(staging), str(ADAPTERS / adapter)],
            capture_output=True)
        shutil.rmtree(ADAPTERS / adapter / "build", ignore_errors=True)
        wheels = list(staging.glob("*.whl"))
        if len(wheels) != 1:
            sys.exit(f"{adapter}: expected one wheel, got {[w.name for w in wheels]}")
        with zipfile.ZipFile(wheels[0]) as built:
            names = built.namelist()
        for name in options.get("requiredFiles", []):
            if f"teststand_adapter_{adapter}/{name}" not in names:
                sys.exit(f"{adapter}: {name} is not in the wheel; add it to package data")
        third_party_wheels(dependencies(meta), staging)
        files = {wheel.name: hashlib.sha256(wheel.read_bytes()).hexdigest() for wheel in sorted(staging.glob("*.whl"))}
        manifest = {
            "formatVersion": 1,
            "kind": "devicePlugin",
            "type": device_type,
            "distribution": meta["project"]["name"],
            "version": meta["project"]["version"],
            **describe(device_type),
            "sdk": sdk_range(meta),
            "vendorDrivers": list(options.get("vendorDrivers", [])),
            "files": files,
            "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        out.mkdir(parents=True, exist_ok=True)
        target = out / f"{device_type}-{manifest['version']}.tsdev"
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("package.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            for name in files:
                archive.write(staging / name, f"wheels/{name}")
    print(f"   -> {target}", flush=True)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("adapters", nargs="*")
    parser.add_argument("--all", action="store_true", help="every adapter under adapters/")
    parser.add_argument("--out", type=Path, default=HERE / "dist")
    parser.add_argument("--skip-tests", action="store_true")
    args = parser.parse_args()
    names = sorted(p.name for p in ADAPTERS.iterdir() if (p / "pyproject.toml").is_file()) if args.all else args.adapters
    if not names:
        parser.error("name an adapter or pass --all")
    if shutil.which("uv") is None:
        sys.exit("uv is required")
    for name in names:
        pack(name, args.out.resolve(), args.skip_tests)
    return 0


if __name__ == "__main__":
    sys.exit(main())
