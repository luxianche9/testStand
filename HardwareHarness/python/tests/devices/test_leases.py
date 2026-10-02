"""Terminal-level leases (design doc §4.5.2) against a scripted device layer."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.contracts.errors import AppError, app_error
from hardwareharness_backend.devices.leases import LeaseManager, terminal_holder

Record = dict[str, Any]
HOLDER = {"terminalId": "T1", "user": "u", "host": "h", "label": "HardwareHarness"}


class Devices:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Record]] = []
        self.heartbeat_error: Exception | None = None
        self.acquire_error: Exception | None = None

    async def call_management(self, hardware_id: str, name: str, args: Record) -> Any:
        self.calls.append((hardware_id, name, args))
        if name == "lease_acquire":
            if self.acquire_error is not None:
                raise self.acquire_error
            return {"leaseId": f"lease-{hardware_id}", "holder": args["holder"], "acquiredAt": 1}
        if name == "lease_heartbeat" and self.heartbeat_error is not None:
            raise self.heartbeat_error
        if name == "lease_status":
            return {"held": True, "holder": HOLDER}
        return {"released": True}

    def names(self, name: str) -> list[str]:
        return [hardware for hardware, called, _ in self.calls if called == name]


async def test_acquires_once_per_device_and_serializes_actuation() -> None:
    devices = Devices()
    leases = LeaseManager(devices, HOLDER, heartbeat_s=60)
    first, second = await asyncio.gather(leases.acquire("H"), leases.acquire("H"))
    assert first == second == "lease-H" and devices.names("lease_acquire") == ["H"]
    assert devices.calls[0][2] == {"holder": HOLDER}
    async with leases.use("H", "read") as lease_id:
        assert lease_id is None and not leases.device_lock("H").locked()
    async with leases.use("H", "actuate") as lease_id:
        assert lease_id == "lease-H" and leases.device_lock("H").locked()
    assert (await leases.status("H"))["heldByThisTerminal"] is True
    await leases.close()
    assert devices.names("lease_release") == ["H"] and leases.lease_for("H") is None


async def test_busy_acquire_is_a_conflict_naming_the_holder() -> None:
    devices = Devices()
    devices.acquire_error = app_error(
        "busy", "leased", {"held": True, "holder": {"user": "bob", "host": "bench"}}
    )
    leases = LeaseManager(devices, HOLDER)
    with pytest.raises(AppError) as caught:
        await leases.acquire("H")
    assert caught.value.category == "conflict" and "bob@bench" in str(caught.value)
    devices.acquire_error = RuntimeError("unreachable")
    with pytest.raises(AppError, match="Could not lease") as unreachable:
        await leases.acquire("H")
    assert unreachable.value.category == "unavailable"


async def test_busy_heartbeat_loses_the_lease_and_tells_the_borrower() -> None:
    devices = Devices()
    notices: list[Record] = []
    leases = LeaseManager(devices, HOLDER, heartbeat_s=0.01)
    leases.set_notifier(notices.append)
    await leases.acquire("H")
    lost: list[tuple[str, str]] = []
    leases.on_lost("H", lambda hardware_id, reason: lost.append((hardware_id, reason)))
    devices.heartbeat_error = app_error("busy", "force released")
    for _ in range(100):
        if lost:
            break
        await asyncio.sleep(0.01)
    assert lost == [("H", "lease_lost")] and leases.lease_for("H") is None
    assert [notice["change"] for notice in notices] == ["acquired", "lost"]
    # Never re-acquired behind the borrower's back; the next call that needs it does.
    assert devices.names("lease_acquire") == ["H"]


async def test_heartbeat_failures_lose_the_lease_after_the_timeout() -> None:
    devices = Devices()
    now = [0.0]
    leases = LeaseManager(devices, HOLDER, heartbeat_s=0.01, timeout_s=10, clock=lambda: now[0])
    await leases.acquire("H")
    lost: list[str] = []
    leases.on_lost("H", lambda hardware_id, reason: lost.append(reason))
    devices.heartbeat_error = ConnectionError("network down")
    await asyncio.sleep(0.05)
    assert lost == [] and leases.lease_for("H") == "lease-H"
    now[0] = 10.0
    for _ in range(100):
        if lost:
            break
        await asyncio.sleep(0.01)
    assert lost == ["heartbeat_timeout"]


async def test_release_and_force_release_end_the_borrowers_lease() -> None:
    devices = Devices()
    leases = LeaseManager(devices, HOLDER, heartbeat_s=60)
    await leases.acquire("H")
    reasons: list[str] = []
    leases.on_lost("H", lambda hardware_id, reason: reasons.append(reason))
    assert await leases.release("H") == {"released": True}
    assert devices.calls[-1] == ("H", "lease_release", {"leaseId": "lease-H"})
    assert await leases.release("H") == {"released": False}
    await leases.acquire("H")
    leases.on_lost("H", lambda hardware_id, reason: reasons.append(reason))
    await leases.force_release("H", "operator confirmed")
    assert devices.calls[-1] == ("H", "lease_force_release", {"reason": "operator confirmed"})
    assert reasons == ["released", "force_released"]


def test_terminal_id_persists(tmp_path: Path) -> None:
    first = terminal_holder(tmp_path)
    assert first["terminalId"] and terminal_holder(tmp_path)["terminalId"] == first["terminalId"]
    stored = json.loads((tmp_path / "terminal.json").read_text(encoding="utf-8"))
    assert stored == {"terminalId": first["terminalId"]}
