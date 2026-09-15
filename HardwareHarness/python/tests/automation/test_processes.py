from __future__ import annotations

import asyncio
import ctypes
import sys
from types import SimpleNamespace
from typing import Any, cast

import pytest

from hardwareharness_backend.automation import processes
from hardwareharness_backend.automation.processes import (
    ProcessJob,
    create_external_process,
    terminate_tree,
)


def test_windows_job_creation_failure_closes_handle() -> None:
    if sys.platform == "win32":
        with pytest.raises(OSError, match="contain"):
            ProcessJob(0)


async def test_windows_fallback_terminates_process_tree() -> None:
    if sys.platform != "win32":
        return
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import time;time.sleep(60)", creationflags=0x08000000
    )
    await terminate_tree(process, None)
    assert process.returncode is not None
    await terminate_tree(process, None)


async def test_posix_group_termination_and_already_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    signals: list[tuple[int, int]] = []
    waited: list[bool] = []

    async def wait() -> int:
        waited.append(True)
        return -9

    def kill(pid: int, signal: int) -> None:
        signals.append((pid, signal))
        if len(signals) > 1:
            raise ProcessLookupError()

    monkeypatch.setattr(processes, "os", SimpleNamespace(name="posix", killpg=kill))
    monkeypatch.setattr(processes, "signal", SimpleNamespace(SIGKILL=9))
    process = cast(asyncio.subprocess.Process, SimpleNamespace(returncode=None, pid=42, wait=wait))
    job = ProcessJob(42)
    assert job.handle is None
    await terminate_tree(process, job)
    await terminate_tree(process, None)
    assert signals == [(42, 9), (42, 9)]
    assert waited == [True, True]


def test_job_creation_api_failure_without_handles(monkeypatch: pytest.MonkeyPatch) -> None:
    class Api:
        def __init__(self, result: int) -> None:
            self.result = result

        def __call__(self, *args: Any) -> int:
            return self.result

    kernel = SimpleNamespace(
        CreateJobObjectW=Api(0),
        OpenProcess=Api(0),
        SetInformationJobObject=Api(0),
        AssignProcessToJobObject=Api(0),
        CloseHandle=Api(0),
    )
    monkeypatch.setattr(processes, "os", SimpleNamespace(name="nt"))
    import ctypes

    monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: kernel)
    with pytest.raises(OSError, match="contain"):
        ProcessJob(10)


@pytest.mark.parametrize(
    "previous,spawn_fails,clear_fails",
    [
        ("bundle\\_internal", False, False),
        (None, False, False),
        ("bundle\\_internal", True, False),
        ("bundle\\_internal", False, True),
    ],
)
async def test_frozen_child_dll_directory_is_cleared_and_parent_restored(
    monkeypatch: pytest.MonkeyPatch,
    previous: str | None,
    spawn_fails: bool,
    clear_fails: bool,
) -> None:
    current = previous
    calls = []

    class Api:
        def __init__(self, kind: str) -> None:
            self.kind = kind

        def __call__(self, *args: Any) -> int:
            nonlocal current
            if self.kind == "get":
                if args[0] and current:
                    args[1].value = current
                return len(current or "")
            calls.append(args[0])
            if clear_fails:
                return 0
            current = args[0]
            return 1

    kernel = SimpleNamespace(GetDllDirectoryW=Api("get"), SetDllDirectoryW=Api("set"))
    monkeypatch.setattr(processes, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: kernel)
    expected = cast(asyncio.subprocess.Process, SimpleNamespace(pid=42))

    async def spawn(*command: str, **options: Any) -> asyncio.subprocess.Process:
        assert current is None
        assert command == ("python.exe", "-I", "-c", "pass")
        if spawn_fails:
            raise OSError("spawn failed")
        return expected

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    if clear_fails or spawn_fails:
        with pytest.raises(OSError):
            await create_external_process("python.exe", "-I", "-c", "pass")
    else:
        assert await create_external_process("python.exe", "-I", "-c", "pass") is expected
    assert current == previous
    assert calls == ([None] if clear_fails else [None, previous])
