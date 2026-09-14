from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace
from typing import Any, cast

import pytest

from hardwareharness_backend.automation import processes
from hardwareharness_backend.automation.processes import ProcessJob, terminate_tree


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
