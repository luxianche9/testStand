from __future__ import annotations

import asyncio
import shutil
import sys
from pathlib import Path

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.workspace import environment as environment_module
from hardwareharness_backend.workspace.environment import EnvironmentManager


def test_scaffold_does_not_replace_existing_project_code(tmp_path: Path) -> None:
    root = tmp_path / ".hardwareharness"
    root.mkdir()
    (root / "pyproject.toml").write_text("# user dependencies\n")
    manager = EnvironmentManager()
    manager.scaffold(str(tmp_path))
    assert (root / "pyproject.toml").read_text() == "# user dependencies\n"
    assert (root / "workflows").is_dir()
    assert not (root / "apps/example").exists()


@pytest.mark.parametrize("online", [False, True])
async def test_mutating_environment_rejected_while_active(tmp_path: Path, online: bool) -> None:
    manager = EnvironmentManager(busy=lambda: True)
    with pytest.raises(AppError) as error:
        await manager.prepare(str(tmp_path), online=online)
    assert error.value.category == "conflict"


async def test_frozen_runtime_missing_resources_fails_explicitly(tmp_path: Path) -> None:
    manager = EnvironmentManager(resources=tmp_path / "absent", frozen=True)
    with pytest.raises(AppError, match="runtime"):
        await manager.prepare(str(tmp_path))


def test_runtime_resolution_does_not_use_pyinstaller_as_python(tmp_path: Path) -> None:
    runtime = tmp_path / "project-runtime"
    (runtime / "python").mkdir(parents=True)
    (runtime / "python/python.exe").write_bytes(b"interpreter")
    (runtime / "uv.exe").write_bytes(b"uv")
    (runtime / "wheels").mkdir()
    manager = EnvironmentManager(resources=runtime, frozen=True)
    assert manager._runtime() == (str(runtime / "python/python.exe"), str(runtime / "uv.exe"))
    assert manager._runtime()[0] != sys.executable


def test_default_project_pins_sdk_and_web_dependencies(tmp_path: Path) -> None:
    manager = EnvironmentManager()
    manager.scaffold(str(tmp_path))
    text = (tmp_path / ".hardwareharness/pyproject.toml").read_text()
    assert "hardwareharness==0.1.0" in text
    assert "fastapi==" in text
    assert "ruff==" in text
    assert manager.info(str(tmp_path))["status"] == "missing"


class RecordingEnvironment(EnvironmentManager):
    def __init__(self, resources: Path) -> None:
        super().__init__(resources=resources, frozen=True)
        self.commands: list[list[str]] = []

    async def _command(self, command: list[str], cwd: Path) -> None:
        self.commands.append(command)
        interpreter = self._venv_python(str(cwd.parent))
        interpreter.parent.mkdir(parents=True, exist_ok=True)
        interpreter.write_bytes(b"python")


def runtime_tree(tmp_path: Path) -> Path:
    resources = tmp_path / "runtime"
    (resources / "python").mkdir(parents=True)
    (resources / "python/python.exe").write_bytes(b"python")
    (resources / "uv.exe").write_bytes(b"uv")
    (resources / "wheels").mkdir()
    return resources


async def test_prepare_pins_offline_environment_and_does_not_replace_code(tmp_path: Path) -> None:
    resources = runtime_tree(tmp_path)
    manager = RecordingEnvironment(resources)
    root = tmp_path / "中文 space"
    info = await manager.prepare(str(root))
    assert info["status"] == "ready"
    assert Path(await manager.python(str(root))).is_file()
    assert len(manager.commands) == 2
    assert "--offline" in manager.commands[-1] and "--no-index" in manager.commands[-1]
    assert "--find-links" in manager.commands[-1]
    assert (root / ".hardwareharness/.venv/hardwareharness-environment.json").is_file()
    await manager.prepare(str(root), online=True)
    assert "--offline" not in manager.commands[-1]
    shutil.rmtree(resources / "wheels")
    with pytest.raises(AppError, match="wheelhouse"):
        await manager.prepare(str(root))
    assert manager.info(str(root))["error"]


async def test_python_prepares_missing_environment(tmp_path: Path) -> None:
    manager = RecordingEnvironment(runtime_tree(tmp_path))
    assert Path(await manager.python(str(tmp_path / "project"))).is_file()


async def test_environment_command_failure_includes_stderr(tmp_path: Path) -> None:
    with pytest.raises(AppError) as failure:
        await EnvironmentManager()._command(
            [sys.executable, "-c", "import sys; print('broken',file=sys.stderr); sys.exit(2)"],
            tmp_path,
        )
    assert failure.value.details["exitCode"] == 2
    assert "broken" in failure.value.details["output"]
    await EnvironmentManager()._command([sys.executable, "-c", "print('ok')"], tmp_path)


def test_dev_requires_uv_and_frozen_env_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HARDWAREHARNESS_PROJECT_RUNTIME", str(tmp_path))
    assert EnvironmentManager().resources == tmp_path
    monkeypatch.delenv("HARDWAREHARNESS_PROJECT_RUNTIME")
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(AppError, match="uv"):
        EnvironmentManager(frozen=False)._runtime()


async def test_development_missing_sdk_fails_before_uv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = EnvironmentManager(frozen=False)
    monkeypatch.setattr(manager, "_runtime", lambda: (sys.executable, "uv"))
    old_is_dir = Path.is_dir

    def is_dir(path: Path) -> bool:
        return False if path.name == "sdk" else old_is_dir(path)

    monkeypatch.setattr(Path, "is_dir", is_dir)
    with pytest.raises(AppError, match="SDK wheel"):
        await manager.prepare(str(tmp_path))


def test_packaged_default_locates_runtime_beside_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HARDWAREHARNESS_PROJECT_RUNTIME", raising=False)
    manager = EnvironmentManager(frozen=True)
    assert manager.resources == Path(sys.executable).resolve().parent.parent / "project-runtime"
    manager.resources = None
    with pytest.raises(AppError, match="runtime"):
        manager._runtime()


async def test_development_sync_uses_built_sdk_wheel_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resources = runtime_tree(tmp_path)
    manager = RecordingEnvironment(resources)
    manager.resources, manager.frozen = None, False
    source = tmp_path / "python/src/hardwareharness_backend/workspace/environment.py"
    local_wheels = tmp_path / "python/dist/sdk"
    local_wheels.mkdir(parents=True)
    manager.scaffold(str(tmp_path / "project"))
    monkeypatch.setattr(environment_module, "__file__", str(source))
    monkeypatch.setattr(manager, "_runtime", lambda: (sys.executable, "uv"))
    await manager.prepare(str(tmp_path / "project"))
    assert str(local_wheels) in manager.commands[-1]
    assert "--offline" not in manager.commands[-1]


async def test_failed_partial_environment_is_not_treated_as_ready(tmp_path: Path) -> None:
    manager = RecordingEnvironment(runtime_tree(tmp_path))
    root = tmp_path / "project"
    await manager.prepare(str(root))
    (root / ".hardwareharness/pyproject.toml").write_text("# changed dependencies\n")
    assert manager.info(str(root))["status"] == "missing"
    await manager.python(str(root))
    assert manager.info(str(root))["status"] == "ready"
    marker = root / ".hardwareharness/.venv/hardwareharness-environment.json"
    marker.write_bytes(b"{truncated")
    assert manager.info(str(root))["status"] == "missing"
    marker.write_bytes(b"[]")
    assert manager.info(str(root))["status"] == "missing"


async def test_cancelling_environment_command_terminates_its_process(tmp_path: Path) -> None:
    marker = tmp_path / "started"
    source = "import pathlib,time; pathlib.Path('started').write_text('ready'); time.sleep(60)"
    task = asyncio.create_task(
        EnvironmentManager()._command([sys.executable, "-c", source], tmp_path)
    )
    async with asyncio.timeout(5):
        while not marker.exists():
            await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_cancel_pending_drains_python_preparation_and_lock_waiters(tmp_path: Path) -> None:
    entered = asyncio.Event()

    class SlowEnvironment(EnvironmentManager):
        async def _command(self, command: list[str], cwd: Path) -> None:
            entered.set()
            await super()._command(
                [
                    sys.executable,
                    "-c",
                    "import pathlib,time; "
                    "pathlib.Path('started').write_text('ready'); time.sleep(60)",
                ],
                cwd,
            )

    manager = SlowEnvironment(resources=runtime_tree(tmp_path))
    first = asyncio.create_task(manager.python(str(tmp_path / "project")))
    await entered.wait()
    async with asyncio.timeout(5):
        while not (tmp_path / "project/.hardwareharness/started").exists():
            await asyncio.sleep(0.02)
    second = asyncio.create_task(manager.prepare(str(tmp_path / "other")))
    await asyncio.sleep(0)
    await manager.cancel_pending()
    assert first.cancelled() and second.cancelled()
    assert not manager._preparations and not manager._preparing
    assert manager.info(str(tmp_path / "project"))["status"] == "missing"
    # A project switch can use the same manager once its previous preparations have drained.
    await manager.cancel_pending()
    assert not manager._cancelling


async def test_new_prepare_is_rejected_during_cancellation(tmp_path: Path) -> None:
    manager = EnvironmentManager()
    manager._cancelling = True
    with pytest.raises(AppError, match="stopping"):
        await manager.prepare(str(tmp_path))
