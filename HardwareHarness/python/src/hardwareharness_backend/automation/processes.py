from __future__ import annotations

import asyncio
import ctypes
import os
import signal
import sys
from contextlib import suppress
from typing import Any

_external_spawn_lock = asyncio.Lock()


async def create_external_process(*command: str, **options: Any) -> asyncio.subprocess.Process:
    """Keep PyInstaller's Windows DLL search directory out of external child processes."""
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return await asyncio.create_subprocess_exec(*command, **options)
    async with _external_spawn_lock:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetDllDirectoryW.argtypes = [ctypes.c_uint32, ctypes.c_wchar_p]
        kernel.GetDllDirectoryW.restype = ctypes.c_uint32
        kernel.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
        kernel.SetDllDirectoryW.restype = ctypes.c_int
        length = kernel.GetDllDirectoryW(0, None)
        buffer = ctypes.create_unicode_buffer(length + 1)
        if length:
            kernel.GetDllDirectoryW(len(buffer), buffer)
        previous = buffer.value or None
        if not kernel.SetDllDirectoryW(None):
            raise OSError(ctypes.get_last_error(), "Cannot reset DLL search for external process")
        try:
            return await asyncio.create_subprocess_exec(*command, **options)
        finally:
            kernel.SetDllDirectoryW(previous)


class ProcessJob:
    """Windows job closes descendants even after a successful workflow parent exits."""

    def __init__(self, pid: int) -> None:
        self.handle: Any = None
        if os.name != "nt":
            return
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.restype = ctypes.c_void_p
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        kernel.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.CreateJobObjectW(None, None)
        # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Windows x64;
        # BasicLimitInformation.LimitFlags is a DWORD at offset 16.
        info = ctypes.create_string_buffer(144)
        ctypes.c_uint32.from_buffer(info, 16).value = 0x2000  # KILL_ON_JOB_CLOSE
        process = kernel.OpenProcess(0x0100 | 0x0001, False, pid)
        try:
            if (
                not handle
                or not process
                or not kernel.SetInformationJobObject(handle, 9, info, len(info))
                or not kernel.AssignProcessToJobObject(handle, process)
            ):
                if handle:
                    kernel.CloseHandle(handle)
                raise OSError(ctypes.get_last_error(), "Cannot contain workflow process tree")
            self.handle = handle
        finally:
            if process:
                kernel.CloseHandle(process)

    def close(self) -> None:
        if self.handle:
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(self.handle)
            self.handle = None


async def terminate_tree(process: asyncio.subprocess.Process, job: ProcessJob | None) -> None:
    if job is not None and job.handle:
        job.close()
    elif process.returncode is None:
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=0x08000000,
            )
            await killer.wait()
        else:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)  # type: ignore[attr-defined]
    await process.wait()
