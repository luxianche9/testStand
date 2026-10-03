from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class AbortError(Exception):
    name = "AbortError"


class AbortSignal:
    def __init__(self) -> None:
        self.aborted = False
        self.reason: Exception | None = None
        self._event = asyncio.Event()
        self._callbacks: list[Callable[[], None]] = []

    async def wait(self) -> None:
        await self._event.wait()

    def add_callback(self, callback: Callable[[], None]) -> None:
        self._callbacks.append(callback)

    def remove_callback(self, callback: Callable[[], None]) -> None:
        if callback in self._callbacks:
            self._callbacks.remove(callback)

    def throw_if_aborted(self) -> None:
        if self.aborted:
            raise self.reason or AbortError("Aborted")


class AbortController:
    def __init__(self, parent: AbortSignal | None = None) -> None:
        self.signal = AbortSignal()
        if parent is not None:

            def linked() -> None:
                self.abort(parent.reason or AbortError("Parent operation cancelled"))

            if parent.aborted:
                linked()
            else:
                parent.add_callback(linked)

    def abort(self, reason: Exception | None = None) -> None:
        if self.signal.aborted:
            return
        self.signal.aborted = True
        self.signal.reason = reason or AbortError("Aborted")
        self.signal._event.set()
        for callback in list(self.signal._callbacks):
            callback()
        self.signal._callbacks.clear()


_detached: set[asyncio.Task[object]] = set()


def _consume(task: asyncio.Task[object]) -> None:
    _detached.discard(task)
    if not task.cancelled():
        task.exception()


async def with_abort(operation: Awaitable[T], signal: AbortSignal) -> T:
    async def invoke() -> T:
        return await operation

    task = asyncio.create_task(invoke())
    abort = asyncio.create_task(signal.wait())
    try:
        done, _ = await asyncio.wait([task, abort], return_when=asyncio.FIRST_COMPLETED)
        if signal.aborted:
            if not task.done():
                _detached.add(task)
                task.add_done_callback(_consume)
            else:
                task.exception()
            raise signal.reason or AbortError("Aborted")
        if task in done:
            return await task
        raise AbortError("Aborted")
    finally:
        abort.cancel()
        await asyncio.gather(abort, return_exceptions=True)


async def abortable_delay(milliseconds: float, signal: AbortSignal) -> None:
    signal.throw_if_aborted()
    try:
        await asyncio.wait_for(signal.wait(), milliseconds / 1000)
    except TimeoutError:
        return
    signal.throw_if_aborted()
