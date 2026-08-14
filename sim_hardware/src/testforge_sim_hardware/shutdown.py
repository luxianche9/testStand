from __future__ import annotations

import asyncio
import os
import signal
from collections.abc import Callable
from typing import Any, Protocol


class SafeStopDriver(Protocol):
    def safe_stop(self) -> Any: ...


def exit_process() -> None:
    os.kill(os.getpid(), signal.SIGINT)


async def prepare_safe_shutdown(
    driver: SafeStopDriver,
    hardware_id: str,
    error_payload: Callable[[Exception], dict[str, Any]],
    timestamp: Callable[[], str],
    *,
    process_exit: Callable[[], None] = exit_process,
    delay: float = 0.25,
) -> dict[str, Any]:
    try:
        detail = str(driver.safe_stop())
    except Exception as exc:
        return {"ok": False, "error": error_payload(exc), "meta": {"timestamp": timestamp()}}

    async def exit_later() -> None:
        await asyncio.sleep(delay)
        process_exit()

    asyncio.create_task(exit_later())
    return {
        "ok": True,
        "data": {"hardwareId": hardware_id, "safe": True, "detail": detail},
        "meta": {"timestamp": timestamp()},
    }

