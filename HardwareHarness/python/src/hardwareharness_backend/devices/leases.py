"""Terminal-level hardware leases (design doc §4.5.2).

The holder is this terminal instance, not a run: a lease is acquired the first
time a ``configure`` / ``actuate`` call needs it (a run start or a manual
device-page call) and kept until the terminal exits or the user releases it.
One heartbeat task per held lease proves the terminal is alive; the server
drops a lease without a heartbeat for ``timeoutMs`` and drives the device to
its safe state.

A lease is lost when a heartbeat answers ``busy`` (unknown, released or force
released lease) or when heartbeats keep failing for ``timeoutMs``. Loss is
reported to the listeners of that hardware (the run using it aborts); the lease
is never re-acquired behind their back, only on the next call that needs it.
"""

from __future__ import annotations

import asyncio
import contextlib
import getpass
import json
import logging
import socket
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from hardwareharness_backend.contracts.errors import app_error

Record = dict[str, Any]
LostListener = Callable[[str, str], None]

log = logging.getLogger(__name__)

LEASED_KINDS = frozenset({"configure", "actuate"})
HEARTBEAT_INTERVAL_S = 2.0
LEASE_TIMEOUT_S = 10.0
RELEASE_TIMEOUT_S = 3.0
TERMINAL_FILE = "terminal.json"


def terminal_holder(user_data: Path, label: str = "HardwareHarness") -> Record:
    """``{terminalId, user, host, label}``; the terminalId persists in ``terminal.json``."""
    path = user_data / TERMINAL_FILE
    terminal_id = ""
    with contextlib.suppress(OSError, ValueError, AttributeError):
        terminal_id = str(json.loads(path.read_text(encoding="utf-8")).get("terminalId") or "")
    if not terminal_id:
        terminal_id = str(uuid.uuid4())
        with contextlib.suppress(OSError):
            path.write_text(json.dumps({"terminalId": terminal_id}) + "\n", encoding="utf-8")
    holder = {"terminalId": terminal_id, "label": label}
    with contextlib.suppress(Exception):
        holder["user"] = getpass.getuser()[:128]
    with contextlib.suppress(Exception):
        holder["host"] = socket.gethostname()[:128]
    return holder


@dataclass
class _Held:
    lease_id: str
    acquired_at: Any
    last_ok: float
    heartbeat: asyncio.Task[None] | None = None
    listeners: list[LostListener] = field(default_factory=list)


class LeaseManager:
    def __init__(
        self,
        devices: Any,
        holder: Record,
        *,
        heartbeat_s: float = HEARTBEAT_INTERVAL_S,
        timeout_s: float = LEASE_TIMEOUT_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.devices, self.holder = devices, dict(holder)
        self.heartbeat_s, self.timeout_s, self.clock = heartbeat_s, timeout_s, clock
        self._held: dict[str, _Held] = {}
        self._acquiring: dict[str, asyncio.Lock] = {}
        self._device_locks: dict[str, asyncio.Lock] = {}
        self._notifier: Callable[[Record], None] | None = None
        self._closed = False

    def set_notifier(self, notifier: Callable[[Record], None]) -> None:
        self._notifier = notifier

    @property
    def supported(self) -> bool:
        return hasattr(self.devices, "call_management")

    # -- holding -------------------------------------------------------------------------------

    def lease_for(self, hardware_id: str) -> str | None:
        held = self._held.get(hardware_id)
        return held.lease_id if held is not None else None

    def device_lock(self, hardware_id: str) -> asyncio.Lock:
        """One ``configure`` / ``actuate`` at a time per device inside this terminal."""
        return self._device_locks.setdefault(hardware_id, asyncio.Lock())

    async def acquire(self, hardware_id: str) -> str | None:
        """The lease of ``hardware_id``, acquired now if not held. Failure raises.

        ``None`` only when the device layer has no lease support at all.
        """
        if not self.supported:
            return None
        if self._closed:
            raise app_error("unavailable", "The terminal is shutting down")
        async with self._acquiring.setdefault(hardware_id, asyncio.Lock()):
            held = self._held.get(hardware_id)
            if held is not None:
                return held.lease_id
            try:
                grant = await self.devices.call_management(
                    hardware_id, "lease_acquire", {"holder": self.holder}
                )
            except Exception as error:
                details = getattr(error, "details", None)
                holder = details.get("holder") if isinstance(details, dict) else None
                if getattr(error, "category", None) == "busy":
                    raise app_error(
                        "conflict",
                        f"Hardware {hardware_id} is leased by {_describe(holder)}",
                        {"hardwareId": hardware_id, "holder": holder, "message": str(error)},
                    ) from error
                raise app_error(
                    "unavailable",
                    f"Could not lease hardware {hardware_id}: {error}",
                    {"hardwareId": hardware_id},
                ) from error
            held = _Held(str(grant["leaseId"]), grant.get("acquiredAt"), self.clock())
            self._held[hardware_id] = held
            held.heartbeat = asyncio.create_task(
                self._heartbeat(hardware_id, held), name=f"lease-heartbeat-{hardware_id}"
            )
            self._notify("acquired", hardware_id)
            return held.lease_id

    @contextlib.asynccontextmanager
    async def use(self, hardware_id: str, kind: str) -> AsyncIterator[str | None]:
        """Around one manual tool call: lease and serialize ``configure`` / ``actuate``."""
        if kind not in LEASED_KINDS:
            yield None
            return
        lease_id = await self.acquire(hardware_id)
        async with self.device_lock(hardware_id):
            yield lease_id

    def on_lost(self, hardware_id: str, listener: LostListener) -> Callable[[], None]:
        """Call ``listener(hardwareId, reason)`` on loss of this lease; returns unsubscribe."""
        held = self._held.get(hardware_id)
        if held is None:
            return lambda: None
        held.listeners.append(listener)

        def unsubscribe() -> None:
            with contextlib.suppress(ValueError):
                held.listeners.remove(listener)

        return unsubscribe

    # -- ending --------------------------------------------------------------------------------

    async def release(self, hardware_id: str) -> Record:
        """The user's "release": end our lease; the server drives the device safe."""
        held = self._drop(hardware_id)
        if held is None:
            return {"released": False}
        self._lost(hardware_id, held, "released")
        result = await self.devices.call_management(
            hardware_id, "lease_release", {"leaseId": held.lease_id}
        )
        return dict(result) if isinstance(result, dict) else {"released": True}

    async def force_release(self, hardware_id: str, reason: str) -> Record:
        """End whoever holds ``hardware_id`` (the UI confirmed twice)."""
        held = self._drop(hardware_id)
        if held is not None:
            self._lost(hardware_id, held, "force_released")
        result = await self.devices.call_management(
            hardware_id, "lease_force_release", {"reason": reason}
        )
        return dict(result) if isinstance(result, dict) else {"released": True}

    async def status(self, hardware_id: str) -> Record:
        status = await self.devices.call_management(hardware_id, "lease_status", {})
        status = dict(status) if isinstance(status, dict) else {"held": False}
        holder = status.get("holder")
        status["heldByThisTerminal"] = bool(
            status.get("held")
            and isinstance(holder, dict)
            and holder.get("terminalId") == self.holder["terminalId"]
        )
        return status

    async def close(self) -> None:
        """Release every lease; nothing here blocks exit (the heartbeat timeout is the fallback)."""
        self._closed = True
        hardware_ids = list(self._held)
        await asyncio.gather(
            *(self._release_quietly(hardware_id) for hardware_id in hardware_ids),
            return_exceptions=True,
        )

    async def _release_quietly(self, hardware_id: str) -> None:
        held = self._drop(hardware_id)
        if held is None:
            return
        try:
            await asyncio.wait_for(
                self.devices.call_management(
                    hardware_id, "lease_release", {"leaseId": held.lease_id}
                ),
                RELEASE_TIMEOUT_S,
            )
            self._notify("released", hardware_id)
        except Exception as error:
            log.warning("Releasing the lease on %s failed: %s", hardware_id, error)

    def _drop(self, hardware_id: str) -> _Held | None:
        held = self._held.pop(hardware_id, None)
        heartbeat = held.heartbeat if held is not None else None
        if heartbeat is not None and heartbeat is not asyncio.current_task():
            heartbeat.cancel()
        return held

    def _lost(self, hardware_id: str, held: _Held, reason: str) -> None:
        self._notify("released" if reason == "released" else "lost", hardware_id, reason)
        for listener in list(held.listeners):
            try:
                listener(hardware_id, reason)
            except Exception:
                log.exception("A lease-lost listener failed")
        held.listeners.clear()

    async def _heartbeat(self, hardware_id: str, held: _Held) -> None:
        while True:
            await asyncio.sleep(self.heartbeat_s)
            try:
                await self.devices.call_management(
                    hardware_id, "lease_heartbeat", {"leaseId": held.lease_id}
                )
                held.last_ok = self.clock()
                continue
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if getattr(error, "category", None) == "busy":
                    reason = "lease_lost"
                elif self.clock() - held.last_ok >= self.timeout_s:
                    reason = "heartbeat_timeout"
                else:
                    log.warning("Lease heartbeat on %s failed: %s", hardware_id, error)
                    continue
            if self._held.get(hardware_id) is held:
                self._drop(hardware_id)
                log.warning("Lost the lease on %s (%s)", hardware_id, reason)
                self._lost(hardware_id, held, reason)
            return

    def _notify(self, change: str, hardware_id: str, reason: str | None = None) -> None:
        if self._notifier is None:
            return
        with contextlib.suppress(Exception):
            self._notifier(
                {
                    "change": change,
                    "hardwareId": hardware_id,
                    **({"reason": reason} if reason else {}),
                }
            )


def _describe(holder: Any) -> str:
    if not isinstance(holder, dict):
        return "another terminal"
    user, host = holder.get("user"), holder.get("host")
    if user and host:
        return f"{user}@{host}"
    return str(holder.get("label") or holder.get("terminalId") or "another terminal")
