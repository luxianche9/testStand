"""Load a device as a plugin of the host process, in process or in an isolated child process.

:func:`open_device` builds the device type named by its ``hardwareharness.devices`` entry
point and returns a handle with one async interface whatever ``Device.isolation`` says:

* ``inproc`` — :class:`InprocDevice` calls the :class:`~.host.DeviceHost` directly.
* ``subprocess`` — :class:`SubprocessDevice` runs the host in a child process
  (``python -m hardwareharness_device_sdk.child``) and talks JSON lines over its stdio.
  The child keeps the real stdout for the protocol and points file descriptor 1 at stderr
  before the adapter is imported, so a driver that prints cannot corrupt it. On stdin EOF
  (the parent exited or closed it) the child drives the device safe, closes it and exits; on
  Windows a job object also kills the child when the parent process dies.

Protocol: the parent writes ``{"id", "method", "params"}`` lines, the child answers
``{"id", "result"}`` or ``{"id", "error": {"message", "category"}}``; requests run
concurrently in the child (the device's ``io_lock`` still serializes driver work).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import itertools
import json
import logging
import os
import sys
from collections.abc import Sequence
from typing import Any, Protocol

from .config import ServerConfig
from .device_types import load_device
from .errors import DEVICE_UNREACHABLE, DeviceError
from .host import DeviceHost

log = logging.getLogger("hardwareharness_device_sdk.plugin")

STOP_TIMEOUT = 10.0
CHILD_MODULE = "hardwareharness_device_sdk.child"


class DeviceHandle(Protocol):
    """What the host application needs from a loaded device."""

    isolation: str

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def describe(self) -> dict[str, Any]: ...
    async def call(self, name: str, arguments: dict[str, Any], operation_id: str | None = None) -> dict[str, Any]: ...
    async def read_stream(self, stream_id: str, cursor: int | None, limit: int,
                          epoch: str | None = None) -> dict[str, Any]: ...
    async def seek(self, stream_id: str, since: float) -> int: ...
    async def watch(self, stream_id: str) -> None: ...
    async def unwatch(self, stream_id: str) -> None: ...
    async def read_blob(self, stream_id: str, ref: str) -> dict[str, Any]: ...
    async def safe_all(self) -> list[dict[str, Any]]: ...


def describe_host(host: DeviceHost) -> dict[str, Any]:
    """Tools (``tools/list`` entries), the ``/device`` document and the hardware snapshot."""
    return {"tools": host.describe_tools(), "device": host.manifest().document,
            "hardware": host.manager.list_hardware()}


class InprocDevice:
    isolation = "inproc"

    def __init__(self, host: DeviceHost) -> None:
        self.host = host

    async def start(self) -> None:
        await self.host.start()

    async def stop(self) -> None:
        await self.host.stop()

    async def describe(self) -> dict[str, Any]:
        return describe_host(self.host)

    async def call(self, name: str, arguments: dict[str, Any], operation_id: str | None = None) -> dict[str, Any]:
        return await self.host.call(name, arguments, operation_id=operation_id)

    async def read_stream(self, stream_id: str, cursor: int | None, limit: int,
                          epoch: str | None = None) -> dict[str, Any]:
        return self.host.read_stream(stream_id, cursor, limit, epoch)

    async def seek(self, stream_id: str, since: float) -> int:
        return self.host.seek(stream_id, since)

    async def watch(self, stream_id: str) -> None:
        self.host.watch(stream_id)

    async def unwatch(self, stream_id: str) -> None:
        self.host.unwatch(stream_id)

    async def read_blob(self, stream_id: str, ref: str) -> dict[str, Any]:
        mime, content = self.host.read_blob(stream_id, ref)
        return {"ref": ref, "mime": mime, "size": len(content), "base64": base64.b64encode(content).decode("ascii")}

    async def safe_all(self) -> list[dict[str, Any]]:
        return await self.host.safe_all()


class SubprocessDevice:
    isolation = "subprocess"

    def __init__(self, device_type: str, config: ServerConfig, command: Sequence[str] | None = None) -> None:
        self.device_type, self.config = device_type, config
        self.command = list(command or (sys.executable, "-m", CHILD_MODULE))
        self.process: asyncio.subprocess.Process | None = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._reader: asyncio.Task[None] | None = None
        self._job: Any = None

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=None,
            limit=1 << 24)
        self._job = _kill_with_parent(self.process)
        self._reader = asyncio.create_task(self._read(), name=f"plugin:{self.config.hardware_id}")
        await self._request("start", {"type": self.device_type, "config": _config_mapping(self.config)})

    async def stop(self) -> None:
        process = self.process
        if process is None:
            return
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._request("stop", {}), STOP_TIMEOUT)
        if process.stdin is not None:
            process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), STOP_TIMEOUT)
        except TimeoutError:
            process.kill()
            await process.wait()
        if self._reader is not None:
            await asyncio.gather(self._reader, return_exceptions=True)
        self.process = None

    async def describe(self) -> dict[str, Any]:
        return dict(await self._request("describe", {}))

    async def call(self, name: str, arguments: dict[str, Any], operation_id: str | None = None) -> dict[str, Any]:
        return dict(await self._request("call", {"name": name, "arguments": arguments, "operationId": operation_id}))

    async def read_stream(self, stream_id: str, cursor: int | None, limit: int,
                          epoch: str | None = None) -> dict[str, Any]:
        return dict(await self._request("read_stream", {"streamId": stream_id, "cursor": cursor, "limit": limit,
                                                        "epoch": epoch}))

    async def seek(self, stream_id: str, since: float) -> int:
        return int(await self._request("seek", {"streamId": stream_id, "since": since}))

    async def watch(self, stream_id: str) -> None:
        await self._request("watch", {"streamId": stream_id})

    async def unwatch(self, stream_id: str) -> None:
        await self._request("unwatch", {"streamId": stream_id})

    async def read_blob(self, stream_id: str, ref: str) -> dict[str, Any]:
        return dict(await self._request("read_blob", {"streamId": stream_id, "ref": ref}))

    async def safe_all(self) -> list[dict[str, Any]]:
        return list(await self._request("safe_all", {}))

    async def _request(self, method: str, params: dict[str, Any]) -> Any:
        process = self.process
        if process is None or process.stdin is None or process.returncode is not None:
            raise DeviceError(f"Device process of {self.config.hardware_id} is not running",
                              category=DEVICE_UNREACHABLE, details={"outcomeKnown": False})
        request_id = next(self._ids)
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            line = json.dumps({"id": request_id, "method": method, "params": params}, ensure_ascii=False)
            process.stdin.write(line.encode("utf-8") + b"\n")
            await process.stdin.drain()
            return await future
        finally:
            self._pending.pop(request_id, None)

    async def _read(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        stdout = self.process.stdout
        try:
            while line := await stdout.readline():
                try:
                    message = json.loads(line)
                except ValueError:
                    log.warning("Device process of %s wrote a non-protocol line: %r",
                                self.config.hardware_id, line[:200])
                    continue
                future = self._pending.get(message.get("id"))
                if future is None or future.done():
                    continue
                if "error" in message:
                    failure = message["error"]
                    future.set_exception(DeviceError(str(failure.get("message")),
                                                     category=str(failure.get("category") or "device_error")))
                else:
                    future.set_result(message.get("result"))
        finally:
            failure = DeviceError(f"Device process of {self.config.hardware_id} exited",
                                  category=DEVICE_UNREACHABLE, details={"outcomeKnown": False})
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(failure)


def open_device(device_type: str, config: ServerConfig, *, child_command: Sequence[str] | None = None,
                retry_delays: tuple[float, ...] = (5, 10, 30)) -> DeviceHandle:
    """A handle for ``device_type`` as its ``Device.isolation`` asks; call ``start()`` next."""
    device_cls = load_device(device_type)
    if device_cls.isolation == "subprocess":
        return SubprocessDevice(device_type, config, child_command)
    return InprocDevice(DeviceHost(device_cls, config, retry_delays=retry_delays))


def _config_mapping(config: ServerConfig) -> dict[str, Any]:
    return {"serverId": config.server_id, "hardwareId": config.hardware_id, "manufacturer": config.manufacturer,
            "model": config.model, "computerId": config.computer_id, "dryRun": config.dry_run,
            "settings": dict(config.settings)}


def _kill_with_parent(process: asyncio.subprocess.Process) -> Any:
    """Windows: put the child in a kill-on-close job object owned by this process."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    class _Limits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class _Counters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("Read", "Write", "Other", "ReadBytes", "WriteBytes",
                                                         "OtherBytes")]

    class _Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _Limits), ("IoInfo", _Counters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.OpenProcess.restype = wintypes.HANDLE
    job = kernel32.CreateJobObjectW(None, None)
    info = _Extended()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    kernel32.SetInformationJobObject(wintypes.HANDLE(job), 9, ctypes.byref(info), ctypes.sizeof(info))
    handle = kernel32.OpenProcess(0x0101, False, process.pid)  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if not handle or not kernel32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(handle)):
        log.warning("Could not tie device process %s to this process (error %s)", process.pid,
                    ctypes.get_last_error())
    if handle:
        kernel32.CloseHandle(wintypes.HANDLE(handle))
    return job  # kept open for the life of this process; closing it kills the child


# --- child side -------------------------------------------------------------------------------

class _Child:
    def __init__(self, out: Any) -> None:
        self.out = out
        self.host: DeviceHost | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    def send(self, message: dict[str, Any]) -> None:
        self.out.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.out.flush()

    async def handle(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        try:
            result = await self.dispatch(str(message.get("method")), message.get("params") or {})
            self.send({"id": request_id, "result": result})
        except Exception as exc:
            category = exc.category if isinstance(exc, DeviceError) else "device_error"
            self.send({"id": request_id, "error": {"message": str(exc), "category": category}})

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "start":
            config = ServerConfig.from_mapping(params["config"], env={})
            self.host = DeviceHost(load_device(params["type"]), config)
            await self.host.start()
            return None
        host = self.host
        if host is None:
            raise DeviceError("The device is not started", category=DEVICE_UNREACHABLE)
        device = InprocDevice(host)
        if method == "describe":
            return await device.describe()
        if method == "call":
            return await device.call(params["name"], params.get("arguments") or {}, params.get("operationId"))
        if method == "read_stream":
            return await device.read_stream(params["streamId"], params.get("cursor"), int(params["limit"]),
                                            params.get("epoch"))
        if method == "seek":
            return await device.seek(params["streamId"], float(params["since"]))
        if method == "watch":
            return await device.watch(params["streamId"])
        if method == "unwatch":
            return await device.unwatch(params["streamId"])
        if method == "read_blob":
            return await device.read_blob(params["streamId"], params["ref"])
        if method == "safe_all":
            return await device.safe_all()
        if method == "stop":
            await self.close()
            return None
        raise DeviceError(f"Unknown method {method}")

    async def close(self) -> None:
        host, self.host = self.host, None
        if host is not None:
            await host.stop()

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        stdin = sys.stdin.buffer
        while line := await loop.run_in_executor(None, stdin.readline):
            try:
                message = json.loads(line)
            except ValueError:
                continue
            task = asyncio.create_task(self.handle(message))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        # stdin EOF: the parent is gone or done with us; leave the device safe and closed.
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.close()


def child_main() -> int:
    """Entry of the isolated device process: protocol on the original stdout, everything else to stderr."""
    out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(_Child(out).run())
    return 0

