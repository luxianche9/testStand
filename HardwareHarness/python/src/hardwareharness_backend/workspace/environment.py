from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from hardwareharness_backend.automation.processes import ProcessJob, terminate_tree
from hardwareharness_backend.contracts.errors import AppError

from .files import atomic_write

PROJECT_DEPENDENCIES = (
    "hardwareharness==0.1.0",
    "fastapi==0.135.1",
    "uvicorn==0.41.0",
    "ruff==0.15.6",
    "pytest==9.0.2",
    "pytest-asyncio==1.3.0",
    "httpx==0.28.1",
)
PROJECT_TOML = """[project]
name = "hardwareharness-project"
version = "0.1.0"
requires-python = ">=3.11,<3.12"
dependencies = [
{dependencies}
]

[tool.uv]
package = false

[tool.ruff]
target-version = "py311"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM", "ANN"]
ignore = ["ANN401"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
""".format(dependencies="\n".join(f'  "{dependency}",' for dependency in PROJECT_DEPENDENCIES))


class EnvironmentManager:
    def __init__(
        self,
        *,
        resources: Path | None = None,
        frozen: bool | None = None,
        busy: Callable[[], bool] | None = None,
    ) -> None:
        self.frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
        env_resources = os.environ.get("HARDWAREHARNESS_PROJECT_RUNTIME")
        self.resources = resources or (Path(env_resources) if env_resources else None)
        if self.resources is None and self.frozen:
            self.resources = Path(sys.executable).resolve().parent.parent / "project-runtime"
        self.busy = busy or (lambda: False)
        self._lock = asyncio.Lock()
        self._preparing = False
        self._error: str | None = None
        self._preparations: set[asyncio.Task[Any]] = set()
        self._cancelling = False

    def scaffold(self, root_path: str) -> None:
        root = Path(root_path) / ".hardwareharness"
        root.mkdir(parents=True, exist_ok=True)
        for name in ("workflows", "apps", "tests", "docs"):
            (root / name).mkdir(exist_ok=True)
        target = root / "pyproject.toml"
        if not target.exists():
            try:
                with target.open("x", encoding="utf-8", newline="\n") as stream:
                    stream.write(PROJECT_TOML)
            except FileExistsError:
                pass
        guide = root / "docs/hardwareharness-sdk.md"
        if not guide.exists():
            source = Path(__file__).parent / "templates" / "sdk-guide.md"
            with guide.open("xb") as stream:
                stream.write(source.read_bytes())

    def info(self, root_path: str) -> dict[str, Any]:
        python = self._venv_python(root_path)
        status = (
            "preparing" if self._preparing else "ready" if self._ready(root_path) else "missing"
        )
        return {
            "status": status,
            "pythonPath": str(python) if python.is_file() else None,
            "error": self._error,
        }

    async def python(self, root_path: str) -> str:
        if self._preparing:
            raise AppError(
                "conflict", "Project dependencies are being installed; try again after completion"
            )
        python = self._venv_python(root_path)
        if not self._ready(root_path):
            await self.prepare(root_path)
        return str(python)

    async def prepare(self, root_path: str, *, online: bool = False) -> dict[str, Any]:
        if self._cancelling:
            raise AppError("cancelled", "Project environment preparation is stopping")
        task = asyncio.current_task()
        assert task is not None
        self._preparations.add(task)
        try:
            return await self._prepare(root_path, online=online)
        finally:
            self._preparations.discard(task)

    async def cancel_pending(self) -> None:
        """Drain both running uv commands and preparations waiting for the environment lock."""
        self._cancelling = True
        current = asyncio.current_task()
        pending = [task for task in self._preparations if task is not current]
        try:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        finally:
            self._cancelling = False

    async def _prepare(self, root_path: str, *, online: bool) -> dict[str, Any]:
        async with self._lock:
            if self.busy():
                raise AppError(
                    "conflict", "Stop applications and runs before changing dependencies"
                )
            self._preparing, self._error = True, None
            try:
                python, uv = self._runtime()
                self.scaffold(root_path)
                root = Path(root_path) / ".hardwareharness"
                options = ["--offline", "--no-index"] if not online and self.resources else []
                wheelhouse = self.resources / "wheels" if self.resources else None
                if wheelhouse is not None:
                    if not wheelhouse.is_dir():
                        raise AppError(
                            "unavailable", "Bundled project runtime wheelhouse is missing"
                        )
                    options += ["--find-links", str(wheelhouse)]
                elif not self.frozen:
                    wheelhouse = Path(__file__).resolve().parents[3] / "dist" / "sdk"
                    if wheelhouse.is_dir():
                        options += ["--find-links", str(wheelhouse)]
                    else:
                        raise AppError(
                            "unavailable",
                            "Build the SDK wheel before preparing a project environment",
                            {
                                "command": (
                                    "uv run python scripts/build_project_runtime.py --sdk-only"
                                )
                            },
                        )
                if not self._venv_python(root_path).is_file():
                    await self._command([uv, "venv", "--python", python, ".venv"], root)
                await self._command([uv, "sync", "--python", python, *options], root)
                atomic_write(
                    root / ".venv/hardwareharness-environment.json",
                    (
                        json.dumps(
                            {
                                "sdkVersion": "0.1.0",
                                "python": "3.11",
                                "dependencyHash": self._dependency_hash(root),
                            }
                        )
                        + "\n"
                    ).encode(),
                )
            except Exception as error:
                self._error = str(error)
                raise
            finally:
                self._preparing = False
        return self.info(root_path)

    def _runtime(self) -> tuple[str, str]:
        if self.resources is not None:
            python = self.resources / "python/python.exe"
            uv = self.resources / "uv.exe"
            if not python.is_file() or not uv.is_file():
                raise AppError("unavailable", "Bundled project Python runtime is missing")
            return str(python), str(uv)
        if self.frozen:
            raise AppError("unavailable", "Bundled project Python runtime is missing")
        uv_path = shutil.which("uv")
        if uv_path is None:
            raise AppError("unavailable", "uv is required to prepare the project environment")
        return sys.executable, uv_path

    @staticmethod
    def _venv_python(root_path: str) -> Path:
        return (
            Path(root_path)
            / ".hardwareharness/.venv"
            / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        )

    @staticmethod
    def _dependency_hash(root: Path) -> str:
        digest = hashlib.sha256()
        for name in ("pyproject.toml", "uv.lock"):
            path = root / name
            digest.update(path.read_bytes() if path.exists() else b"")
        return digest.hexdigest()

    def _ready(self, root_path: str) -> bool:
        root = Path(root_path) / ".hardwareharness"
        marker = root / ".venv/hardwareharness-environment.json"
        if not marker.is_file() or not self._venv_python(root_path).is_file():
            return False
        try:
            value = json.loads(marker.read_bytes())
        except (json.JSONDecodeError, UnicodeError):
            return False
        return isinstance(value, dict) and value.get("dependencyHash") == self._dependency_hash(
            root
        )

    async def _command(self, command: list[str], cwd: Path) -> None:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        try:
            job = ProcessJob(process.pid)
        except OSError:
            await terminate_tree(process, None)
            raise
        try:
            stdout, stderr = await process.communicate()
        except asyncio.CancelledError:
            await terminate_tree(process, job)
            raise
        finally:
            job.close()
        if process.returncode != 0:
            raise AppError(
                "unavailable",
                "Project environment installation failed",
                {
                    "exitCode": process.returncode,
                    "output": (stdout + stderr).decode(errors="replace"),
                },
            )
