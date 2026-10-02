"""Hardware lease: one terminal at a time may configure or actuate the device.

Streams and ``read`` tools stay open to everyone; ``safe`` tools are never
blocked. The lease has no business deadline: it lives as long as its holder
keeps sending heartbeats (``lease_heartbeat`` or any tool call carrying
``_meta.leaseId``). A lease without a heartbeat for ``LEASE_TIMEOUT_MS`` is
dropped. However a lease ends (release, timeout, force release), the server
drives the device to its safe state; the table only reports which lease ended.

``LEASE_TIMEOUT_MS`` is a server constant, never set by clients. It is read at
call time, so tests may monkeypatch this module attribute.
"""

from __future__ import annotations

import secrets
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from .clock import now_ms
from .errors import BUSY, INVALID_ARGUMENT, DeviceError

LEASE_TIMEOUT_MS = 10_000
HEARTBEAT_INTERVAL_MS = 2_000
HOLDER_FIELDS = ("terminalId", "user", "host", "label")
MAX_HOLDER_FIELD = 128


def normalize_holder(holder: str | Mapping[str, Any] | BaseModel) -> dict[str, str]:
    """``{terminalId, user?, host?, label?}``; a plain string is the terminalId."""
    if isinstance(holder, BaseModel):
        holder = holder.model_dump(exclude_none=True)
    if isinstance(holder, str):
        holder = {"terminalId": holder}
    if not isinstance(holder, Mapping):
        raise DeviceError("holder must be a terminalId string or {terminalId, user?, host?, label?}",
                          category=INVALID_ARGUMENT)
    unknown = sorted(set(holder) - set(HOLDER_FIELDS))
    if unknown:
        raise DeviceError(f"Unknown holder fields {unknown}; allowed: {list(HOLDER_FIELDS)}", category=INVALID_ARGUMENT)
    result: dict[str, str] = {}
    for key in HOLDER_FIELDS:
        value = holder.get(key)
        if value is None:
            continue
        if not isinstance(value, str) or len(value) > MAX_HOLDER_FIELD or (key == "terminalId" and not value):
            raise DeviceError(f"holder.{key} must be a string of at most {MAX_HOLDER_FIELD} characters",
                              category=INVALID_ARGUMENT)
        result[key] = value
    if "terminalId" not in result:
        raise DeviceError("holder.terminalId is required", category=INVALID_ARGUMENT)
    return result


@dataclass
class Lease:
    lease_id: str
    holder: dict[str, str]
    acquired_at: float
    last_heartbeat_at: float

    @property
    def terminal_id(self) -> str:
        return self.holder["terminalId"]

    def expired(self, now: float) -> bool:
        return now - self.last_heartbeat_at > LEASE_TIMEOUT_MS

    def public(self) -> dict[str, Any]:
        return {"held": True, "holder": dict(self.holder), "acquiredAt": self.acquired_at,
                "lastHeartbeatAt": self.last_heartbeat_at}

    def grant(self) -> dict[str, Any]:
        return {"leaseId": self.lease_id, "holder": dict(self.holder), "acquiredAt": self.acquired_at,
                "heartbeatIntervalMs": HEARTBEAT_INTERVAL_MS, "timeoutMs": LEASE_TIMEOUT_MS}


def _busy(message: str, lease: Lease | None) -> DeviceError:
    return DeviceError(message, category=BUSY, details=lease.public() if lease is not None else {"held": False})


class LeaseTable:
    """At most one lease; every method is short and thread safe."""

    def __init__(self) -> None:
        self._lease: Lease | None = None
        self._lock = threading.Lock()

    def _live(self) -> Lease | None:
        lease = self._lease
        return lease if lease is not None and not lease.expired(now_ms()) else None

    def acquire(self, holder: str | Mapping[str, Any] | BaseModel) -> dict[str, Any]:
        """Grant the lease, or return the existing one to the same terminalId (idempotent)."""
        who = normalize_holder(holder)
        with self._lock:
            lease = self._live()
            if lease is not None and lease.terminal_id != who["terminalId"]:
                raise _busy(f"Hardware is leased by terminal {lease.terminal_id}", lease)
            now = now_ms()
            if lease is None:
                if self._lease is not None:
                    # Lapsed but not yet swept: the caller must end it (safe state) first.
                    raise _busy("The previous lease lapsed and its safe state is pending; retry shortly", None)
                lease = self._lease = Lease(f"lease-{secrets.token_hex(8)}", who, now, now)
            else:
                lease.holder = who
                lease.last_heartbeat_at = now
            return lease.grant()

    def heartbeat(self, lease_id: str) -> dict[str, Any]:
        with self._lock:
            lease = self._live()
            if lease is None or lease.lease_id != lease_id:
                raise _busy("Lease is not held (timed out, released or force released); acquire a new one", lease)
            lease.last_heartbeat_at = now_ms()
            return {"leaseId": lease.lease_id, "lastHeartbeatAt": lease.last_heartbeat_at}

    def touch(self, lease_id: Any) -> bool:
        """Count a tool call carrying ``_meta.leaseId`` as a heartbeat; unknown ids are ignored here."""
        if not isinstance(lease_id, str):
            return False
        with self._lock:
            lease = self._live()
            if lease is None or lease.lease_id != lease_id:
                return False
            lease.last_heartbeat_at = now_ms()
            return True

    def release(self, lease_id: str) -> Lease | None:
        """End the caller's lease and return it; ``None`` when nothing is held. Foreign ids are busy."""
        with self._lock:
            lease = self._live()
            if lease is None:
                return None
            if lease.lease_id != lease_id:
                raise _busy(f"Hardware is leased by terminal {lease.terminal_id}; only the holder may release",
                            lease)
            self._lease = None
            return lease

    def force_release(self) -> Lease | None:
        """End whatever lease is held (live or lapsed) and return it."""
        with self._lock:
            lease, self._lease = self._lease, None
            return lease

    def status_locked(self) -> dict[str, Any]:
        lease = self._live()
        return lease.public() if lease is not None else {"held": False}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self.status_locked()

    def check(self, lease_id: Any) -> None:
        """Allow a configure/actuate call when the device is free or ``lease_id`` holds it.

        A supplied ``leaseId`` that no longer holds the device is refused even
        when the device is free, so a holder notices a lost lease.
        """
        with self._lock:
            lease = self._live()
            if lease is not None and lease.lease_id == lease_id:
                lease.last_heartbeat_at = now_ms()
                return
            if lease is not None:
                raise _busy(f"Hardware is leased by terminal {lease.terminal_id}; configure/actuate tools are refused",
                            lease)
            if lease_id is not None:
                raise _busy("_meta.leaseId no longer holds this hardware (timed out, released or force released)",
                            None)

    def expire(self) -> Lease | None:
        """Drop a lease without a heartbeat for ``LEASE_TIMEOUT_MS``; the caller runs the safe state."""
        with self._lock:
            lease = self._lease
            if lease is not None and lease.expired(now_ms()):
                self._lease = None
                return lease
            return None
