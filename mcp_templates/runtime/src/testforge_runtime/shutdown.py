from __future__ import annotations

import asyncio
import os
import signal
from collections.abc import Callable
from typing import Any, Protocol


class SafeStopDriver(Protocol):
    _state: str

    def safe_stop(self) -> Any: ...


def _exit_process() -> None:
    os.kill(os.getpid(), signal.SIGINT)


async def prepare_safe_shutdown(
    driver: SafeStopDriver,
    hardware_id: str,
    error_payload: Callable[[Exception], dict[str, Any]],
    timestamp: Callable[[], str],
    *,
    exit_process: Callable[[], None] = _exit_process,
    delay: float = 0.3,
) -> dict[str, Any]:
    """Enter the hardware safe state and exit only after that operation succeeds."""

    try:
        driver.safe_stop()
        driver._state = "open"
    except Exception as exc:
        return {"ok": False, "error": error_payload(exc), "meta": {"timestamp": timestamp()}}

    async def exit_later() -> None:
        await asyncio.sleep(delay)
        exit_process()

    asyncio.create_task(exit_later())
    return {"ok": True, "data": {"hardwareId": hardware_id, "safe": True}, "meta": {"timestamp": timestamp()}}
