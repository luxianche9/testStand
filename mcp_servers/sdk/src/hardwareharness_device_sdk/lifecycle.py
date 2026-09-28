"""Device lifecycle: open/safe on start, retry while unreachable, safe/close on stop."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from .device import Device
from .envelope import iso_now
from .errors import DEVICE_ERROR, DEVICE_UNREACHABLE, INVALID_ARGUMENT, SERVICE_UNAVAILABLE, DeviceError
from .pinout import Pinout

HardwareState = Literal["initializing", "open", "unreachable", "faulted", "closing", "closed"]

log = logging.getLogger("hardwareharness_device_sdk.lifecycle")


async def call_blocking(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    if inspect.iscoroutinefunction(fn):
        return await fn(*args, **kwargs)
    return await asyncio.to_thread(fn, *args, **kwargs)


@dataclass
class HardwareRuntime:
    device: Device
    state: HardwareState = "initializing"
    last_error: dict[str, Any] | None = None
    retry_index: int = 0
    next_retry: float = 0.0
    operation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def snapshot(self) -> dict[str, Any]:
        return {
            "hardwareId": self.device.hardware_id,
            "manufacturer": self.device.manufacturer,
            "model": self.device.model,
            "capabilities": list(self.device.capabilities),
            "state": self.state,
            "health": "ok" if self.state == "open" else self.state,
            "lastError": self.last_error,
        }


class HardwareManager:
    def __init__(self, device: Device, *, retry_delays: Sequence[float] = (5, 10, 30),
                 watchdog_interval: float = 1.0) -> None:
        self.device = device
        self.runtime = HardwareRuntime(device)
        self.runtimes = {device.hardware_id: self.runtime}
        self.retry_delays = tuple(retry_delays)
        self.watchdog_interval = watchdog_interval
        self.draining = False
        self.startup_complete = False
        self._watchdog: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()

    def _runtime(self, hardware_id: str) -> HardwareRuntime:
        runtime = self.runtimes.get(hardware_id)
        if runtime is None:
            raise DeviceError(f"Unknown hardwareId: {hardware_id}", category=INVALID_ARGUMENT)
        return runtime

    @property
    def available(self) -> bool:
        return not self.draining and self.runtime.state == "open"

    async def start(self) -> None:
        async with self._start_lock:
            if self.startup_complete and self._watchdog and not self._watchdog.done():
                return
            self.draining = False
            async with self.runtime.operation_lock:
                await self._open_runtime(self.runtime)
            self.startup_complete = True
            self._watchdog = asyncio.create_task(self._watchdog_loop(), name="hardware-watchdog")

    async def _open_runtime(self, runtime: HardwareRuntime) -> None:
        runtime.state = "initializing"
        try:
            await call_blocking(runtime.device.open)
            await call_blocking(runtime.device.safe_state)
            runtime.state = "open"
            runtime.last_error = None
            runtime.retry_index = 0
        except Exception as exc:
            category = exc.category if isinstance(exc, DeviceError) else DEVICE_ERROR
            runtime.state = "unreachable"
            runtime.last_error = {"category": category, "message": str(exc), "at": iso_now()}
            delays = self.retry_delays or (5,)
            runtime.next_retry = time.monotonic() + delays[min(runtime.retry_index, len(delays) - 1)]
            runtime.retry_index += 1
            log.exception("Failed to open %s", runtime.device.hardware_id)

    async def stop(self) -> None:
        self.draining = True
        if self._watchdog:
            self._watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watchdog
        runtime = self.runtime
        async with runtime.operation_lock:
            runtime.state = "closing"
            try:
                await call_blocking(runtime.device.safe_state)
            except Exception:
                log.exception("Safe state failed during shutdown: %s", runtime.device.hardware_id)
            try:
                await call_blocking(runtime.device.close)
                runtime.state = "closed"
            except Exception as exc:
                runtime.state = "faulted"
                runtime.last_error = {"category": DEVICE_ERROR, "message": str(exc), "at": iso_now()}
        self.startup_complete = False
        self._watchdog = None

    async def _watchdog_loop(self) -> None:
        while True:
            now = time.monotonic()
            runtime = self.runtime
            async with runtime.operation_lock:
                if runtime.state == "unreachable" and now >= runtime.next_retry and not self.draining:
                    await self._open_runtime(runtime)
            await asyncio.sleep(self.watchdog_interval)

    async def invoke(self, hardware_id: str, fn: Callable[..., Any], /, **kwargs: Any) -> Any:
        if self.draining:
            raise DeviceError("Server is draining", category=SERVICE_UNAVAILABLE)
        runtime = self._runtime(hardware_id)
        async with runtime.operation_lock:
            if self.draining:
                raise DeviceError("Server is draining", category=SERVICE_UNAVAILABLE)
            if runtime.state != "open":
                raise DeviceError(f"Hardware is not available: {runtime.state}", category=DEVICE_UNREACHABLE,
                                  details=runtime.snapshot())
            return await call_blocking(fn, **kwargs)

    async def sample(self, fn: Callable[[], Any]) -> Any:
        return await self.invoke(self.device.hardware_id, fn)

    async def safe_all(self) -> list[dict[str, Any]]:
        """Safe-state every device regardless of draining; used by prepare_shutdown."""
        runtime = self.runtime
        async with runtime.operation_lock:
            result = await call_blocking(runtime.device.safe_state)
            return [{"hardwareId": runtime.device.hardware_id, "safeResult": result}]

    def get_pinout(self, hardware_id: str) -> Pinout:
        return self._runtime(hardware_id).device.pinout().model_copy(deep=True)

    def list_hardware(self) -> list[dict[str, Any]]:
        return [self.runtime.snapshot()]

    def get_hardware(self, hardware_id: str) -> dict[str, Any]:
        return self._runtime(hardware_id).snapshot()
