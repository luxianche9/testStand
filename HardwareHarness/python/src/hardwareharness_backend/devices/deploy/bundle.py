"""Assembling one deployable bundle: SDK, one adapter, offline wheels, scripts (design 4.8.3).

The bundle is built from the ``mcp_servers`` workspace with ``uv`` and lands in
``mcp_servers/dist/<serverId>/``. It never contains ``server.json``: the token and settings
are written to the remote computer by the deploy pipeline, never into the bundle.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import shutil
import subprocess
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hardwareharness_backend.contracts.errors import app_error

Record = dict[str, Any]
Runner = Callable[[Sequence[str], Path], str]

SOURCE_ENV = "HARDWAREHARNESS_MCP_SOURCE"
SCRIPTS = ("install.ps1", "runner.ps1", "start.ps1", "stop.ps1", "status.ps1", "uninstall.ps1")
SDK_PACKAGE = "hardwareharness-device-sdk"
DEFAULT_PYTHONS = ("3.11", "3.12", "3.13")
PLATFORM = "win_amd64"
NEVER_BUNDLED = frozenset({"server.json"})
REMOTE_ONLY_DIRS = frozenset({"native", "app"})
"""Top-level directories that belong to the remote computer (vendor CLIs), never to a bundle."""

_IDENTITY_SCRIPT = (
    "import importlib, json, sys\n"
    "from hardwareharness_device_sdk import __version__\n"
    "device = importlib.import_module(sys.argv[1]).DEVICE\n"
    "print(json.dumps({'manufacturer': device.manufacturer, 'model': device.model,"
    " 'sdkVersion': __version__}))\n"
)


def run_command(command: Sequence[str], cwd: Path) -> str:
    try:
        completed = subprocess.run(
            list(command), cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8"
        )
    except FileNotFoundError as error:
        raise app_error("unavailable", f"{command[0]} is not installed") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "").strip()[-2000:]
        raise app_error("error", f"{' '.join(command[:4])} failed: {detail}") from error
    return completed.stdout


def mcp_source_root(env: Mapping[str, str] | None = None) -> Path:
    """The ``mcp_servers`` workspace: ``$HARDWAREHARNESS_MCP_SOURCE``, else beside this checkout."""
    configured = (os.environ if env is None else env).get(SOURCE_ENV)
    candidates = [Path(configured)] if configured else []
    candidates += [parent / "mcp_servers" for parent in Path(__file__).resolve().parents]
    for candidate in candidates:
        if (candidate / "pyproject.toml").is_file() and (candidate / "adapters").is_dir():
            return candidate.resolve()
    raise app_error(
        "unavailable",
        f"The mcp_servers source is not available; set {SOURCE_ENV} to its directory",
    )


def adapter_names(adapter: str) -> tuple[str, str]:
    """``cp118u_i`` -> (``hh-adapter-cp118u-i``, ``hh_adapter_cp118u_i``)."""
    return f"hh-adapter-{adapter.replace('_', '-')}", f"hh_adapter_{adapter}"


def list_adapters(source: Path) -> list[Record]:
    adapters: list[Record] = []
    for manifest in sorted((source / "adapters").glob("*/pyproject.toml")):
        project = tomllib.loads(manifest.read_text(encoding="utf-8")).get("project", {})
        name = manifest.parent.name
        package, module = adapter_names(name)
        adapters.append(
            {
                "adapter": name,
                "package": project.get("name", package),
                "module": module,
                "version": str(project.get("version", "")),
                "description": str(project.get("description", "")),
            }
        )
    return adapters


@dataclass(frozen=True)
class BundleFile:
    relative: str
    """Forward-slash path inside the bundle."""
    path: Path
    size: int
    sha256: str


@dataclass(frozen=True)
class Bundle:
    root: Path
    build: Record
    files: tuple[BundleFile, ...]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_bundle(root: Path) -> Bundle:
    """An assembled bundle directory with every file hashed; refuses one holding secrets."""
    build_path = root / "build.json"
    if not build_path.is_file():
        raise app_error("not_found", f"{root} has no build.json; assemble the bundle first")
    files = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if path.name in NEVER_BUNDLED or relative.split("/")[0].lower() in REMOTE_ONLY_DIRS:
            raise app_error("invalid_argument", f"{relative} must never be part of a bundle")
        files.append(BundleFile(relative, path, path.stat().st_size, _sha256(path)))
    return Bundle(root, json.loads(build_path.read_text(encoding="utf-8")), tuple(files))


def _build_wheel(package: str, out: Path, source: Path, run: Runner) -> Path:
    before = set(out.glob("*.whl"))
    run(("uv", "build", "--quiet", "--package", package, "--wheel", "--out-dir", str(out)), source)
    built = sorted(set(out.glob("*.whl")) - before)
    if len(built) != 1:
        raise app_error("error", f"uv build {package} produced {len(built)} wheels")
    return built[0]


def _git(source: Path, run: Runner, *args: str) -> str:
    try:
        return run(("git", *args), source).strip()
    except Exception:
        return ""


def assemble(
    source: Path,
    server_id: str,
    hardware_id: str,
    adapter: str,
    *,
    pythons: Sequence[str] = DEFAULT_PYTHONS,
    wheels: bool = True,
    run: Runner = run_command,
) -> Bundle:
    """Build ``dist/<serverId>/`` from the workspace; nothing on it touches hardware."""
    if not (source / "adapters" / adapter / "pyproject.toml").is_file():
        raise app_error("invalid_argument", f"Unknown adapter {adapter!r}")
    package, module = adapter_names(adapter)
    dist = (source / "dist").resolve()
    target = (dist / server_id).resolve()
    if target.parent != dist:
        raise app_error("invalid_argument", f"Unsafe bundle target: {target}")
    identity = json.loads(
        run(("uv", "run", "--frozen", "--quiet", "python", "-c", _IDENTITY_SCRIPT, module), source)
    )
    if target.exists():
        shutil.rmtree(target)
    wheel_dir = target / "wheels"
    wheel_dir.mkdir(parents=True)
    local = [
        _build_wheel(SDK_PACKAGE, wheel_dir, source, run),
        _build_wheel(package, wheel_dir, source, run),
    ]
    exported = run(
        (
            "uv", "export", "--quiet", "--frozen", "--package", package, "--no-dev",
            "--no-hashes", "--no-emit-workspace", "--no-header", "--no-annotate",
            "--format", "requirements.txt",
        ),
        source,
    )  # fmt: skip
    requirements = target / "requirements.txt"
    requirements.write_text(
        "".join(
            line + "\n"
            for line in exported.splitlines()
            if line.strip() and not line.startswith("#")
        ),
        encoding="utf-8",
    )
    if wheels:
        for version in pythons:
            run(
                (
                    "uvx", "--from", "pip", "pip", "download", "--quiet",
                    "--disable-pip-version-check", "--only-binary=:all:", "--platform", PLATFORM,
                    "--python-version", version, "--dest", str(wheel_dir), "-r", str(requirements),
                ),
                source,
            )  # fmt: skip
    for name in SCRIPTS:
        text = (source / "templates" / name).read_text(encoding="utf-8")
        (target / name).write_text(text.replace("{{ADAPTER_MODULE}}", module), encoding="utf-8")
    commit = _git(source, run, "rev-parse", "HEAD")
    dirty = bool(_git(source, run, "status", "--porcelain", "--", "sdk", "adapters", "templates"))
    build = {
        "serverId": server_id,
        "hardwareId": hardware_id,
        "adapter": adapter,
        "adapterModule": module,
        "manufacturer": identity["manufacturer"],
        "model": identity["model"],
        "sdkVersion": identity["sdkVersion"],
        "gitCommit": commit,
        "dirty": dirty,
        "sourceRevision": f"{commit[:12]}{'-dirty' if dirty else ''}" if commit else None,
        "builtAt": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "pythonVersion": ">=3.11",
        "wheelPythons": list(pythons) if wheels else [],
        "platform": PLATFORM,
        "packages": [
            {"name": wheel.name.split("-")[0], "wheel": wheel.name, "sha256": _sha256(wheel)}
            for wheel in local
        ],
    }
    (target / "build.json").write_text(json.dumps(build, indent=2) + "\n", encoding="utf-8")
    return load_bundle(target)
