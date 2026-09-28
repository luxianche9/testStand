"""Assemble one deployable server bundle: ``dist/<id>/`` = SDK + one adapter + offline wheels + scripts.

    uv run python tools/assemble.py pci1710l
    uv run python tools/assemble.py all --python-versions 3.11,3.12

The bundle is what ``deploy.ps1`` uploads. It never contains ``server.json``
(tokens and settings stay on the remote computer) and never touches hardware.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
TEMPLATES = ROOT / "templates"
SCRIPTS = ("install.ps1", "runner.ps1", "start.ps1", "stop.ps1", "status.ps1")
SDK_PACKAGE = "hardwareharness-device-sdk"
DEFAULT_PYTHONS = "3.11,3.12,3.13"
PLATFORM = "win_amd64"


def run(*command: str, cwd: Path = ROOT) -> str:
    completed = subprocess.run(command, cwd=cwd, check=True, capture_output=True, text=True)
    return completed.stdout


def git(*args: str) -> str:
    try:
        return run("git", *args).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def adapter_names(adapter: str) -> tuple[str, str]:
    """``cp118u_i`` -> (``hh-adapter-cp118u-i``, ``hh_adapter_cp118u_i``)."""
    return f"hh-adapter-{adapter.replace('_', '-')}", f"hh_adapter_{adapter}"


def build_wheel(package: str, out: Path) -> Path:
    before = set(out.glob("*.whl"))
    run("uv", "build", "--quiet", "--package", package, "--wheel", "--out-dir", str(out))
    built = sorted(set(out.glob("*.whl")) - before)
    if len(built) != 1:
        raise RuntimeError(f"uv build {package} produced {len(built)} wheels")
    return built[0]


def export_requirements(package: str) -> str:
    """Third-party runtime dependencies pinned by ``uv.lock`` (workspace packages ship as wheels)."""
    text = run("uv", "export", "--quiet", "--frozen", "--package", package, "--no-dev", "--no-hashes",
               "--no-emit-workspace", "--no-header", "--no-annotate", "--format", "requirements.txt")
    return "".join(line + "\n" for line in text.splitlines() if line.strip() and not line.startswith("#"))


def download_wheels(requirements: Path, out: Path, pythons: list[str]) -> None:
    for version in pythons:
        run("uvx", "--from", "pip", "pip", "download", "--quiet", "--disable-pip-version-check",
            "--only-binary=:all:", "--platform", PLATFORM, "--python-version", version,
            "--dest", str(out), "-r", str(requirements))


def server_example(server: dict[str, Any], device: Any) -> dict[str, Any]:
    port = urlparse(server["mcpUrl"]).port
    if not port:
        raise ValueError(f"{server['id']}: mcpUrl has no port")
    return {"serverId": server["serverId"], "hardwareId": server["hardwareId"],
            "manufacturer": device.manufacturer, "model": device.model, "host": "0.0.0.0", "port": port,
            "token": "<set on the remote computer; never commit>", "settings": {}}


def assemble(server: dict[str, Any], pythons: list[str], wheels: bool) -> Path:
    adapter = server.get("adapter")
    if not adapter or not (ROOT / "adapters" / adapter / "pyproject.toml").is_file():
        raise ValueError(f"{server['id']}: servers.json adapter {adapter!r} has no adapters/<adapter>/pyproject.toml")
    package, module = adapter_names(adapter)
    device = importlib.import_module(module).DEVICE
    from hardwareharness_device_sdk import __version__ as sdk_version

    target = (DIST / server["id"]).resolve()
    if target.parent != DIST.resolve():
        raise ValueError(f"Unsafe bundle target: {target}")
    if target.exists():
        shutil.rmtree(target)
    wheel_dir = target / "wheels"
    wheel_dir.mkdir(parents=True)

    local = [build_wheel(SDK_PACKAGE, wheel_dir), build_wheel(package, wheel_dir)]
    requirements = target / "requirements.txt"
    requirements.write_text(export_requirements(package), encoding="utf-8")
    if wheels:
        download_wheels(requirements, wheel_dir, pythons)

    for name in SCRIPTS:
        text = (TEMPLATES / name).read_text(encoding="utf-8").replace("{{ADAPTER_MODULE}}", module)
        (target / name).write_text(text, encoding="utf-8")
    (target / "server.example.json").write_text(json.dumps(server_example(server, device), indent=2) + "\n",
                                                 encoding="utf-8")

    commit = git("rev-parse", "HEAD")
    dirty = bool(git("status", "--porcelain", "--", "sdk", "adapters", "templates", "uv.lock"))
    build = {
        "serverId": server["serverId"], "hardwareId": server["hardwareId"],
        "adapter": adapter, "adapterModule": module, "manufacturer": device.manufacturer, "model": device.model,
        "sdkVersion": sdk_version, "gitCommit": commit, "dirty": dirty,
        "sourceRevision": f"{commit[:12]}{'-dirty' if dirty else ''}" if commit else None,
        "builtAt": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "pythonVersion": ">=3.11", "wheelPythons": pythons if wheels else [], "platform": PLATFORM,
        "packages": [{"name": wheel.name.split("-")[0], "wheel": wheel.name,
                      "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()} for wheel in local],
    }
    (target / "build.json").write_text(json.dumps(build, indent=2) + "\n", encoding="utf-8")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("server", help="servers.json id, or 'all'.")
    parser.add_argument("--python-versions", default=DEFAULT_PYTHONS,
                        help=f"Comma-separated remote Python versions to fetch wheels for (default {DEFAULT_PYTHONS}).")
    parser.add_argument("--no-wheels", action="store_true",
                        help="Skip third-party wheel download (the remote install then needs a package index).")
    args = parser.parse_args(argv)
    config = json.loads((ROOT / "servers.json").read_text(encoding="utf-8"))
    selected = config["servers"] if args.server == "all" else [s for s in config["servers"] if s["id"] == args.server]
    if not selected:
        parser.error(f"unknown server {args.server!r}")
    pythons = [item.strip() for item in args.python_versions.split(",") if item.strip()]
    for server in selected:
        try:
            target = assemble(server, pythons, wheels=not args.no_wheels)
        except subprocess.CalledProcessError as exc:
            print(f"[assemble] {server['id']}: {' '.join(exc.cmd)} failed\n{exc.stderr}", file=sys.stderr)
            return 1
        count = sum(1 for _ in (target / "wheels").glob("*.whl"))
        print(f"[assemble] {server['id']}: {target.relative_to(ROOT)} ({count} wheels)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
