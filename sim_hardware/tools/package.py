from __future__ import annotations

import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ROOT = ROOT / "hardware_bundles"
OUTPUT_ROOT = ROOT / "output"
ARCHIVE_PATH = OUTPUT_ROOT / "sim-hardware.zip"
EXCLUDED_DIRECTORIES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "dist",
    "logs",
    "out",
    "output",
    "run",
    "tmp",
    "venv",
}
DEFINITIONS = (
    ("virtual-analog-input.tfhw", "analog_input", "SIM_PC.SIM_AI_0"),
    ("virtual-analog-output.tfhw", "analog_output", "SIM_PC.SIM_AO_0"),
    ("virtual-serial-card.tfhw", "serial", "SIM_PC.SIM_SERIAL_0"),
)


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


def _write_entry(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    archive.writestr(_zip_info(name), data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def create_hardware_bundles() -> list[Path]:
    BUNDLE_ROOT.mkdir(parents=True, exist_ok=True)
    bundles: list[Path] = []

    for filename, definition_directory, expected_id in DEFINITIONS:
        source = ROOT / "hardware_definitions" / definition_directory / "hardware.json"
        hardware_bytes = source.read_bytes()
        hardware = json.loads(hardware_bytes)
        if hardware.get("formatVersion") != 2 or hardware.get("hardwareId") != expected_id:
            raise ValueError(f"Invalid hardware definition: {source}")

        manifest = {
            "formatVersion": 2,
            "kind": "hardware",
            "id": expected_id,
            "exportedAt": "1970-01-01T00:00:00.000Z",
        }
        destination = BUNDLE_ROOT / filename
        with zipfile.ZipFile(destination, "w") as archive:
            _write_entry(archive, "bundle.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode())
            _write_entry(archive, "hardware.json", hardware_bytes)
        bundles.append(destination)

    return bundles


def collect_suite_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDED_DIRECTORIES or part.endswith(".egg-info") for part in relative.parts):
            continue
        if path.is_file() and path.name != "server.json" and path.suffix != ".pyc":
            files.append(path)
    return sorted(files, key=lambda item: item.relative_to(ROOT).as_posix())


def create_suite_archive() -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    if ARCHIVE_PATH.exists():
        ARCHIVE_PATH.unlink()

    files = collect_suite_files()
    required = {
        "hardware_bundles/virtual-analog-input.tfhw",
        "install.ps1",
        "package.ps1",
        "servers/analog_input/server.json.example",
        "src/testforge_sim_hardware/runtime.py",
    }
    names = {path.relative_to(ROOT).as_posix() for path in files}
    missing = required - names
    if missing:
        raise ValueError(f"Simulation package is missing: {', '.join(sorted(missing))}")

    with zipfile.ZipFile(ARCHIVE_PATH, "w") as archive:
        for path in files:
            _write_entry(archive, path.relative_to(ROOT).as_posix(), path.read_bytes())


def main() -> None:
    bundles = create_hardware_bundles()
    create_suite_archive()
    for bundle in bundles:
        print(f"Packaged {bundle.relative_to(ROOT)}")
    print(f"Packaged {ARCHIVE_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
