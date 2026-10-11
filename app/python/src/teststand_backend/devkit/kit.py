"""Device plugin development inside a user project, through public tools only (design doc 8.5).

The agent writes an adapter under ``<project>/plugins/<adapter>/`` and never needs testStand's
sources, the repository scripts, ``uv`` or the network:

* :func:`scaffold` renders the bundled adapter template (a digital I/O skeleton that already
  passes the compliance suite on its simulator);
* :func:`check` runs the adapter's own tests and the SDK compliance suite in a child process
  (:mod:`teststand_backend.devkit.runner`, which the frozen backend also provides);
* :func:`pack` builds the wheel itself (pure Python, ``py3-none-any``) and writes
  ``<project>/dist/<type>-<version>.tsdev``, which ``devices.addDeviceFromFile`` installs after
  the operator confirms.

Adapters may use the standard library and ``teststand-device-sdk`` only: a package carries no
third-party wheels because nothing may be downloaded.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import csv
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path, PurePosixPath
from typing import Any

import teststand_device_sdk

from teststand_backend.contracts.errors import AppError

Record = dict[str, Any]

PLUGINS_DIR = "plugins"
DIST_DIR = "dist"
SDK = "teststand-device-sdk"
GROUP = "teststand.devices"
TEMPLATE_SUFFIX = ".tmpl"
RESULT_MARK = "@@devkit-result@@ "
CHECK_TIMEOUT_S = 300.0
MAX_OUTPUT = 60_000
MAX_VENDOR_FILE = 64 * 1024 * 1024
ADAPTER_ID = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
PREFIX = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
VENDOR_SUFFIXES = frozenset({".dll", ".exe", ".bin", ".dat", ".ini", ".cfg", ".json", ".xml"})
SECRET_ENVIRONMENT = ("TESTSTAND_LLM_API_KEY", "TESTSTAND_MCP_TOKEN", "TESTSTAND_PLUGINS_DIR")
EXCLUDED = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"})


def _error(code: str, message: str, recovery: str | None = None, **details: Any) -> AppError:
    return AppError(code, message, {**details, **({"recovery": recovery} if recovery else {})})


def class_name(adapter: str) -> str:
    """``cp118u_i`` -> ``Cp118uI``."""
    return "".join(part[:1].upper() + part[1:] for part in adapter.split("_"))


def sdk_range() -> str:
    """The SDK range a new adapter declares: the installed minor version."""
    major, minor = (int(part) for part in teststand_device_sdk.__version__.split(".")[:2])
    upper = f"{major}.{minor + 1}" if major == 0 else f"{major + 1}"
    return f">={major}.{minor},<{upper}"


def _substitute(text: str, values: dict[str, str]) -> str:
    # Longest placeholders first so __PREFIX_UPPER__ is not split by __PREFIX__.
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(key, values[key])
    return text


def _template_files() -> list[tuple[str, str]]:
    """``(relative path without .tmpl, text)`` of every bundled template file."""
    output: list[tuple[str, str]] = []

    def walk(node: Any, prefix: str) -> None:
        for child in node.iterdir():
            relative = f"{prefix}{child.name}"
            if child.is_dir():
                walk(child, f"{relative}/")
            elif child.name.endswith(TEMPLATE_SUFFIX):
                output.append(
                    (relative.removesuffix(TEMPLATE_SUFFIX), child.read_text(encoding="utf-8"))
                )

    walk(files(__package__).joinpath("template"), "")
    return sorted(output)


@dataclass(frozen=True)
class Adapter:
    """An adapter project inside the user project."""

    root: Path
    adapter: str

    @property
    def package(self) -> str:
        return f"teststand_adapter_{self.adapter}"

    @property
    def source(self) -> Path:
        return self.root / "src" / self.package

    @property
    def relative(self) -> str:
        return f"{PLUGINS_DIR}/{self.adapter}"


def adapter_dir(project: Path, adapter: str, *, exists: bool = True) -> Adapter:
    if not ADAPTER_ID.fullmatch(adapter or ""):
        raise _error(
            "invalid_argument",
            f"Adapter id {adapter!r} must be lowercase letters, digits and single underscores, "
            "starting with a letter (e.g. rsx8 or jcxd_sd48)",
        )
    root = project / PLUGINS_DIR / adapter
    if exists and not (root / "pyproject.toml").is_file():
        raise _error(
            "not_found",
            f"No adapter {adapter!r} in this project ({root} has no pyproject.toml)",
            "Create it with devkit_create_adapter first.",
        )
    return Adapter(root, adapter)


def scaffold(project: Path, adapter: str, prefix: str, model: str, manufacturer: str) -> Record:
    """Render the template into ``plugins/<adapter>``; never overwrites."""
    target = adapter_dir(project, adapter, exists=False)
    if not PREFIX.fullmatch(prefix or ""):
        raise _error("invalid_argument", f"Tool prefix {prefix!r} must match {PREFIX.pattern}")
    for label, value in (("model", model), ("manufacturer", manufacturer)):
        if not value.strip() or any(c in value for c in '"\\\n'):
            raise _error(
                "invalid_argument", f"{label} must be one line without quotes or backslashes"
            )
    if target.root.exists():
        raise _error(
            "conflict",
            f"{target.relative} already exists; edit it instead of creating it again",
        )
    values = {
        "__ADAPTER__": adapter,
        "__PACKAGE__": target.package,
        "__DIST__": f"teststand-adapter-{adapter.replace('_', '-')}",
        "__PREFIX__": prefix,
        "__PREFIX_UPPER__": prefix.upper(),
        "__CLASS__": class_name(adapter),
        "__MODEL__": model.strip(),
        "__MANUFACTURER__": manufacturer.strip(),
        "__SDK_RANGE__": sdk_range(),
    }
    written: list[str] = []
    for relative, text in _template_files():
        path = target.root / _substitute(relative, values)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_substitute(text, values), encoding="utf-8", newline="\n")
        written.append(path.relative_to(project).as_posix())
    return {
        "adapter": adapter,
        "deviceType": adapter,
        "path": target.relative,
        "package": target.package,
        "className": values["__CLASS__"],
        "files": written,
        "next": [
            "Read the device-plugin guide (read_reference ts-device-plugin) and the manual.",
            "Write driver.py (ctypes binding), sim.py, adapter.py, pinout.py; resolve every "
            "TODO(new_device).",
            f"devkit_check_adapter {adapter} until it passes, then devkit_package_adapter.",
        ],
    }


def _inside(path: Path, roots: list[Path]) -> bool:
    resolved = path.resolve()
    return any(resolved.is_relative_to(root.resolve()) for root in roots)


def add_vendor_file(
    project: Path, adapter: str, source: str, target: str | None, protected: list[Path]
) -> Record:
    """Copy a vendor binary (driver DLL, bridge executable) into the adapter package.

    Text files can be written directly; binaries cannot, so this is the one copy path. The file
    lands in ``src/<package>/<target>`` (default ``bin/<name>``) and is listed under
    ``requiredFiles`` so the package always carries it.
    """
    item = adapter_dir(project, adapter)
    origin = Path(source)
    if not origin.is_absolute():
        origin = project / origin
    if _inside(origin, protected):
        raise _error("permission_denied", "testStand's own folders are not a vendor file source")
    if not origin.is_file():
        raise _error("not_found", f"{origin} is not a file")
    if origin.suffix.lower() not in VENDOR_SUFFIXES:
        raise _error(
            "invalid_argument",
            f"Only vendor runtime files ({', '.join(sorted(VENDOR_SUFFIXES))}) are copied; "
            "write source files directly",
        )
    if origin.stat().st_size > MAX_VENDOR_FILE:
        raise _error("invalid_argument", "Vendor files are limited to 64 MiB")
    name = target or f"bin/{origin.name}"
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
        raise _error("invalid_argument", "target must be a relative path inside the package")
    destination = item.source.joinpath(*relative.parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(origin, destination)
    _require_file(item, relative.as_posix())
    return {
        "adapter": adapter,
        "path": destination.relative_to(project).as_posix(),
        "packagePath": relative.as_posix(),
        "bytes": destination.stat().st_size,
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "loadWith": f"Path(__file__).resolve().parent / {relative.as_posix()!r} (in driver.py)",
    }


def _require_file(item: Adapter, name: str) -> None:
    """Add ``name`` to ``[tool.teststand.package] requiredFiles`` in the adapter's pyproject."""
    path = item.root / "pyproject.toml"
    text = path.read_text(encoding="utf-8")
    meta = tomllib.loads(text)
    required = list(
        meta.get("tool", {}).get("teststand", {}).get("package", {}).get("requiredFiles", [])
    )
    if name in required:
        return
    required.append(name)
    line = "requiredFiles = [" + ", ".join(json.dumps(item) for item in required) + "]"
    updated, count = re.subn(r"^requiredFiles\s*=\s*\[[^\]]*\]", line, text, flags=re.MULTILINE)
    if not count:
        if "[tool.teststand.package]" not in text:
            updated = text.rstrip("\n") + "\n\n[tool.teststand.package]\nvendorDrivers = []\n"
        updated = updated.replace(
            "[tool.teststand.package]\n", f"[tool.teststand.package]\n{line}\n", 1
        )
    tomllib.loads(updated)
    path.write_text(updated, encoding="utf-8", newline="\n")


# -- child process ---------------------------------------------------------------------------


def runner_command() -> list[str]:
    """How to start :mod:`teststand_backend.devkit.runner`: the frozen backend has no ``-m``."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--devkit"]
    return [sys.executable, "-m", "teststand_backend.devkit.runner"]


def child_environment() -> dict[str, str]:
    environment = {
        key: value for key, value in os.environ.items() if key.upper() not in SECRET_ENVIRONMENT
    }
    environment.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            # The simulator only: checking an adapter never touches hardware.
            "HARDWARE_DRY_RUN": "1",
        }
    )
    return environment


async def run_child(arguments: list[str], cwd: Path, timeout_s: float) -> tuple[Record, str]:
    """Run the runner; returns its result record and its combined, bounded output."""
    process = await asyncio.create_subprocess_exec(
        *runner_command(),
        *arguments,
        cwd=str(cwd),
        env=child_environment(),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        raw, _ = await asyncio.wait_for(process.communicate(), timeout_s)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        await process.wait()
        raise _error(
            "timeout",
            f"The adapter check did not finish within {int(timeout_s)} s",
            "A test or the simulator probably blocks (a read loop without timeout, a sleep, "
            "real hardware access in dry-run). Fix it and check again.",
        ) from None
    text = raw.decode("utf-8", errors="replace")
    result: Record | None = None
    lines = []
    for line in text.splitlines():
        if line.startswith(RESULT_MARK):
            with contextlib.suppress(ValueError):
                result = json.loads(line[len(RESULT_MARK) :])
        else:
            lines.append(line)
    output = "\n".join(lines)
    if len(output) > MAX_OUTPUT:
        output = output[: MAX_OUTPUT // 2] + "\n…(output shortened)…\n" + output[-MAX_OUTPUT // 2 :]
    if result is None:
        result = {"ok": False, "error": f"The checker exited with code {process.returncode}"}
    return result, output


def _todo_markers(item: Adapter) -> list[str]:
    found = []
    for path in sorted(item.root.rglob("*")):
        if path.is_file() and path.suffix in {".py", ".toml", ".md"}:
            for number, line in enumerate(
                path.read_text("utf-8", errors="replace").splitlines(), 1
            ):
                if "TODO(new_device)" in line:
                    found.append(f"{path.relative_to(item.root).as_posix()}:{number}")
    return found


def _project(item: Adapter) -> Record:
    path = item.root / "pyproject.toml"
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise _error("invalid_argument", f"{item.relative}/pyproject.toml: {error}") from error


def _static_findings(item: Adapter, meta: Record) -> tuple[list[str], list[str]]:
    """Problems found without running anything: packaging rules and stdout use."""
    problems: list[str] = []
    warnings: list[str] = []
    project = meta.get("project", {})
    points = project.get("entry-points", {}).get(GROUP, {})
    if set(points) != {item.adapter}:
        problems.append(
            f'pyproject.toml must declare exactly one [project.entry-points."{GROUP}"] entry '
            f'named {item.adapter!r} = "{item.package}:DEVICE"'
        )
    extra = [d for d in project.get("dependencies", []) if not d.lower().startswith(SDK)]
    if extra:
        problems.append(
            f"Dependencies {extra} cannot be packaged: testStand installs offline, so adapters "
            "use the standard library (ctypes, winreg, socket, struct, ...) and the SDK only"
        )
    if not item.source.is_dir():
        problems.append(f"Package folder src/{item.package} is missing")
    else:
        options = meta.get("tool", {}).get("teststand", {}).get("package", {})
        for name in options.get("requiredFiles", []):
            if not (item.source / name).is_file():
                problems.append(f"requiredFiles lists {name}, which is not in src/{item.package}")
        for path in sorted(item.source.rglob("*.py")):
            text = path.read_text("utf-8", errors="replace")
            for number, line in enumerate(text.splitlines(), 1):
                if re.match(r"\s*print\(", line):
                    problems.append(
                        f"{path.relative_to(item.root).as_posix()}:{number}: print() writes to the "
                        "backend's stdout; use logging"
                    )
    return problems, warnings


async def check(project: Path, adapter: str, *, timeout_s: float = CHECK_TIMEOUT_S) -> Record:
    """Static rules, the adapter's tests and the compliance suite, on the simulator only."""
    item = adapter_dir(project, adapter)
    meta = _project(item)
    problems, warnings = _static_findings(item, meta)
    result, output = await run_child(["check", str(item.root), item.adapter], item.root, timeout_s)
    todos = _todo_markers(item)
    ok = bool(result.get("ok")) and not problems and not todos
    summary = {
        "adapter": adapter,
        "ok": ok,
        "problems": problems,
        "todoMarkers": todos,
        "tests": result.get("tests"),
        "compliance": result.get("compliance"),
        "declaration": result.get("declaration"),
        "warnings": [*warnings, *result.get("warnings", [])],
        "output": output,
    }
    if result.get("error"):
        summary["error"] = result["error"]
    if todos:
        summary["next"] = "Resolve every TODO(new_device) marker from the manual (or ask the user)."
    return summary


# -- packaging -------------------------------------------------------------------------------


def _record_hash(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"sha256={digest}"


def build_wheel(item: Adapter, meta: Record) -> tuple[str, bytes]:
    """A ``py3-none-any`` wheel of ``src/<package>`` with the entry point, built in memory."""
    project = meta["project"]
    distribution = re.sub(r"[-_.]+", "_", project["name"]).lower()
    version = str(project["version"])
    info = f"{distribution}-{version}.dist-info"
    entries: list[tuple[str, bytes]] = []
    for path in sorted(item.source.rglob("*")):
        relative = path.relative_to(item.source)
        if path.is_file() and not set(relative.parts) & EXCLUDED and path.suffix != ".pyc":
            entries.append((f"{item.package}/{relative.as_posix()}", path.read_bytes()))
    requires = [f"Requires-Dist: {d}" for d in project.get("dependencies", [])]
    metadata = "\n".join(
        [
            "Metadata-Version: 2.1",
            f"Name: {project['name']}",
            f"Version: {version}",
            f"Summary: {project.get('description', '')}",
            f"Requires-Python: {project.get('requires-python', '>=3.11')}",
            *requires,
            "",
        ]
    )
    points = project.get("entry-points", {}).get(GROUP, {})
    entry_points = f"[{GROUP}]\n" + "".join(f"{k} = {v}\n" for k, v in points.items())
    wheel = (
        "Wheel-Version: 1.0\nGenerator: teststand-devkit\nRoot-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
    )
    entries += [
        (f"{info}/METADATA", metadata.encode()),
        (f"{info}/WHEEL", wheel.encode()),
        (f"{info}/entry_points.txt", entry_points.encode()),
    ]
    record = io.StringIO()
    writer = csv.writer(record, lineterminator="\n")
    for name, data in entries:
        writer.writerow([name, _record_hash(data), len(data)])
    writer.writerow([f"{info}/RECORD", "", ""])
    entries.append((f"{info}/RECORD", record.getvalue().encode()))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), data)
    return f"{distribution}-{version}-py3-none-any.whl", buffer.getvalue()


async def pack(project: Path, adapter: str, *, timeout_s: float = CHECK_TIMEOUT_S) -> Record:
    """Check, then write ``dist/<type>-<version>.tsdev``; a failing check writes nothing."""
    report = await check(project, adapter, timeout_s=timeout_s)
    if not report["ok"]:
        raise _error(
            "failed_precondition",
            f"{adapter} does not pass devkit_check_adapter; no package was written",
            "Fix the reported problems, run devkit_check_adapter again, then package.",
            check={key: report[key] for key in ("problems", "todoMarkers", "tests", "compliance")},
        )
    item = adapter_dir(project, adapter)
    meta = _project(item)
    description, _ = await run_child(["describe", str(item.root), adapter], item.root, 60.0)
    if not description.get("ok"):
        raise _error("internal_error", "The adapter class could not be described", **description)
    name, wheel = build_wheel(item, meta)
    options = meta.get("tool", {}).get("teststand", {}).get("package", {})
    sdk = next(
        (
            d[len(SDK) :].strip()
            for d in meta["project"]["dependencies"]
            if d.lower().startswith(SDK)
        ),
        None,
    )
    manifest = {
        "formatVersion": 1,
        "kind": "devicePlugin",
        "type": adapter,
        "distribution": meta["project"]["name"],
        "version": str(meta["project"]["version"]),
        **{key: description[key] for key in ("manufacturer", "model", "isolation", "description")},
        "sdk": sdk or ">=0",
        "vendorDrivers": list(options.get("vendorDrivers", [])),
        "files": {name: hashlib.sha256(wheel).hexdigest()},
        "builtAt": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    out = project / DIST_DIR
    out.mkdir(exist_ok=True)
    target = out / f"{adapter}-{manifest['version']}.tsdev"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("package.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        archive.writestr(f"wheels/{name}", wheel)
    return {
        "adapter": adapter,
        "path": str(target),
        "relativePath": target.relative_to(project).as_posix(),
        "manifest": manifest,
        "check": {key: report[key] for key in ("tests", "compliance", "warnings")},
        "next": "Add it with devices_addDeviceFromFile(path); the operator confirms the manifest.",
    }
