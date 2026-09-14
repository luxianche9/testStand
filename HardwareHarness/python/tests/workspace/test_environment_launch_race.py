from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from hardwareharness_backend.contracts.errors import AppError

from .test_environment import RecordingEnvironment, runtime_tree


async def test_ready_interpreter_cannot_launch_during_dependency_installation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = RecordingEnvironment(runtime_tree(tmp_path))
    root = tmp_path / "project"
    await manager.prepare(str(root))
    entered, finish = asyncio.Event(), asyncio.Event()
    command = manager._command

    async def paused_command(arguments: list[str], cwd: Path) -> None:
        entered.set()
        await finish.wait()
        await command(arguments, cwd)

    monkeypatch.setattr(manager, "_command", paused_command)
    install = asyncio.create_task(manager.prepare(str(root), online=True))
    try:
        await entered.wait()
        assert manager._ready(str(root))  # The old completion marker still exists.
        with pytest.raises(AppError) as error:
            await manager.python(str(root))
        assert error.value.category == "conflict"
    finally:
        finish.set()
        await install
    assert Path(await manager.python(str(root))).is_file()
