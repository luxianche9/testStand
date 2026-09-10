import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class SerializedWriter:
    """FIFO read/modify/write serialization; a failure never poisons later operations."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    async def enqueue(self, operation: Callable[[], Awaitable[T]]) -> T:
        async with self._lock:
            return await operation()

    async def flush(self) -> None:
        async with self._lock:
            pass
