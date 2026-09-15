from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from hardwareharness_remote.adapters import AdapterError
from hardwareharness_remote.lifecycle import HardwareManager


class DirectOperationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.adapter = SimpleNamespace(
            hardware_id="H", manufacturer="test", model="fake", capabilities=[],
            open=AsyncMock(), safe=AsyncMock(), close=AsyncMock(),
            invoke=AsyncMock(return_value={"value": 3}),
        )
        with patch("hardwareharness_remote.lifecycle.build_adapters", return_value=[self.adapter]):
            self.manager = HardwareManager()
        await self.manager.start()

    async def asyncTearDown(self) -> None:
        await self.manager.stop()

    async def test_operation_runs_immediately_after_start(self) -> None:
        result = await self.manager.invoke("H", "read", channel=0)
        self.assertEqual(result, {"value": 3})
        self.adapter.invoke.assert_awaited_once_with("read", channel=0)

    async def test_serializes_hardware_operations_and_preserves_safe_shutdown(self) -> None:
        entered, finish = asyncio.Event(), asyncio.Event()
        calls = []

        async def invoke(operation: str) -> str:
            calls.append(operation)
            if operation == "first":
                entered.set()
                await finish.wait()
            return operation

        self.adapter.invoke.side_effect = invoke
        first = asyncio.create_task(self.manager.invoke("H", "first"))
        await entered.wait()
        second = asyncio.create_task(self.manager.invoke("H", "second"))
        await asyncio.sleep(0)
        self.assertEqual(calls, ["first"])
        finish.set()
        self.assertEqual(await asyncio.gather(first, second), ["first", "second"])
        await self.manager.stop()
        self.adapter.safe.assert_awaited()
        self.adapter.close.assert_awaited()
        with self.assertRaises(AdapterError):
            await self.manager.invoke("H", "read")

    async def test_unknown_or_offline_hardware_is_rejected(self) -> None:
        with self.assertRaises(AdapterError):
            await self.manager.invoke("missing", "read")
        self.manager.runtimes["H"].state = "unreachable"
        with self.assertRaises(AdapterError):
            await self.manager.invoke("H", "read")
        self.adapter.invoke.assert_not_awaited()
