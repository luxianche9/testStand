from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from hardwareharness_remote.adapters import AdapterError, HardwareAdapter, build_adapters
from hardwareharness_remote.pinouts import Pinout
from hardwareharness_remote.occupancy import OccupancyRegistry

HardwareState = Literal["initializing", "open", "unreachable", "faulted", "closing", "closed"]

log = logging.getLogger("hardwareharness_remote.lifecycle")


def iso_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class HardwareRuntime:
    adapter: HardwareAdapter
    state: HardwareState = "initializing"
    last_error: dict[str, Any] | None = None
    retry_index: int = 0
    next_retry: float = 0.0
    operation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def snapshot(self) -> dict[str, Any]:
        return {
            "hardwareId": self.adapter.hardware_id,
            "manufacturer": self.adapter.manufacturer,
            "model": self.adapter.model,
            "capabilities": self.adapter.capabilities,
            "state": self.state,
            "health": "ok" if self.state == "open" else self.state,
            "lastError": self.last_error,
        }


class HardwareManager:
    def __init__(self) -> None:
        self.runtimes = {adapter.hardware_id: HardwareRuntime(adapter) for adapter in build_adapters()}
        self.draining = False
        self.startup_complete = False
        self._watchdog: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()
        self.occupancy = OccupancyRegistry()

    def _runtime(self, hardware_id: str) -> HardwareRuntime:
        runtime = self.runtimes.get(hardware_id)
        if runtime is None:
            raise AdapterError(f"Unknown hardwareId: {hardware_id}", category="invalid_argument")
        return runtime

    async def start(self) -> None:
        async with self._start_lock:
            if self.startup_complete and self._watchdog and not self._watchdog.done():
                return
            self.draining = False
            for hardware_id in sorted(self.runtimes):
                await self._open_runtime(self.runtimes[hardware_id])
            self.startup_complete = True
            self._watchdog = asyncio.create_task(self._watchdog_loop(), name="hardware-watchdog")

    async def _open_runtime(self, runtime: HardwareRuntime) -> None:
        runtime.state = "initializing"
        try:
            await runtime.adapter.open()
            await runtime.adapter.safe()
            runtime.state = "open"
            runtime.last_error = None
            runtime.retry_index = 0
        except Exception as exc:
            category = exc.category if isinstance(exc, AdapterError) else "device_error"
            runtime.state = "unreachable"
            runtime.last_error = {"category": category, "message": str(exc), "at": iso_now()}
            delays = (5, 10, 30)
            runtime.next_retry = time.monotonic() + delays[min(runtime.retry_index, len(delays) - 1)]
            runtime.retry_index += 1
            log.exception("Failed to open %s", runtime.adapter.hardware_id)

    async def stop(self) -> None:
        self.draining = True
        if self._watchdog:
            self._watchdog.cancel()
            try:
                await self._watchdog
            except asyncio.CancelledError:
                pass
        for hardware_id in sorted(self.runtimes, reverse=True):
            runtime = self.runtimes[hardware_id]
            async with runtime.operation_lock:
                runtime.state = "closing"
                try:
                    await runtime.adapter.safe()
                except Exception:
                    log.exception("Safe state failed during shutdown: %s", hardware_id)
                finally:
                    self.occupancy.clear_locked(hardware_id)
                try:
                    await runtime.adapter.close()
                    runtime.state = "closed"
                except Exception as exc:
                    runtime.state = "faulted"
                    runtime.last_error = {"category": "device_error", "message": str(exc), "at": iso_now()}
        self.startup_complete = False
        self._watchdog = None

    async def _watchdog_loop(self) -> None:
        while True:
            now = time.monotonic()
            for runtime in self.runtimes.values():
                async with runtime.operation_lock:
                    try:
                        await self.occupancy.expire_locked(runtime)
                    except Exception:
                        log.exception("Safe state failed for expired occupancy lease: %s", runtime.adapter.hardware_id)
                    if runtime.state == "unreachable" and now >= runtime.next_retry and not self.draining:
                        await self._open_runtime(runtime)
            await asyncio.sleep(1)

    async def invoke(self, hardware_id: str, operation: str, occupancy_lease_id: str | None, **kwargs: Any) -> Any:
        if self.draining:
            raise AdapterError("Server is draining", category="service_unavailable")
        runtime = self._runtime(hardware_id)
        async with runtime.operation_lock:
            if self.draining:
                raise AdapterError("Server is draining", category="service_unavailable")
            if runtime.state != "open":
                raise AdapterError(f"Hardware is not available: {runtime.state}", category="device_unreachable", details=runtime.snapshot())
            await self.occupancy.require_locked(runtime, occupancy_lease_id)
            return await runtime.adapter.invoke(operation, **kwargs)

    async def occupancy_action(self, hardware_id: str, action: str, holder_id: str | None = None, holder_label: str | None = None, lease_id: str | None = None) -> dict[str, Any]:
        runtime = self._runtime(hardware_id)
        async with runtime.operation_lock:
            return await self.occupancy.action_locked(runtime, action, holder_id, holder_label, lease_id)

    def get_pinout(self, hardware_id: str) -> Pinout:
        return self._runtime(hardware_id).adapter.pinout.model_copy(deep=True)

    def list_hardware(self) -> list[dict[str, Any]]:
        return [self.runtimes[key].snapshot() for key in sorted(self.runtimes)]

    def get_hardware(self, hardware_id: str) -> dict[str, Any]:
        return self._runtime(hardware_id).snapshot()
