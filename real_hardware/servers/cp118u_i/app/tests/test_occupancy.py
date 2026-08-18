from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace

from testforge_remote.occupancy import OccupancyRegistry


class FakeAdapter:
    hardware_id = "HW1"

    def __init__(self) -> None:
        self.safe_calls = 0

    async def safe(self) -> None:
        self.safe_calls += 1


class OccupancyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.adapter = FakeAdapter()
        self.runtime = SimpleNamespace(adapter=self.adapter, operation_lock=asyncio.Lock())
        self.registry = OccupancyRegistry(ttl_seconds=0.03)

    async def test_conflict_release_and_stale_isolation(self) -> None:
        async with self.runtime.operation_lock:
            await self.registry.action_locked(self.runtime, "acquire", "A", "Alice", "L1")
            with self.assertRaisesRegex(Exception, "already occupied"):
                await self.registry.action_locked(self.runtime, "acquire", "B", "Bob", "L2")
            await self.registry.action_locked(self.runtime, "release", "A", lease_id="L1")
            await self.registry.action_locked(self.runtime, "acquire", "B", "Bob", "L2")
            status = await self.registry.action_locked(self.runtime, "release", "A", lease_id="L1")
        self.assertEqual(status["holderId"], "B")
        self.assertEqual(self.adapter.safe_calls, 1)

    async def test_expiry_safe_and_old_lease_rejected(self) -> None:
        async with self.runtime.operation_lock:
            await self.registry.action_locked(self.runtime, "acquire", "A", "Alice", "L1")
        await asyncio.sleep(0.05)
        async with self.runtime.operation_lock:
            expired = await self.registry.expire_locked(self.runtime)
            self.assertTrue(expired)
            with self.assertRaisesRegex(Exception, "requires a current"):
                await self.registry.require_locked(self.runtime, "L1")
        self.assertEqual(self.adapter.safe_calls, 1)

    async def test_heartbeat_renews_current_lease(self) -> None:
        self.registry = OccupancyRegistry(ttl_seconds=0.2)
        async with self.runtime.operation_lock:
            first = await self.registry.action_locked(self.runtime, "acquire", "A", "Alice", "L1")
        await asyncio.sleep(0.01)
        async with self.runtime.operation_lock:
            renewed = await self.registry.action_locked(self.runtime, "heartbeat", "A", lease_id="L1")
        self.assertGreater(renewed["expiresAt"], first["expiresAt"])


if __name__ == "__main__":
    unittest.main()
