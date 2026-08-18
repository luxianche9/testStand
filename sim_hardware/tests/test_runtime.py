from __future__ import annotations

import asyncio
import unittest

from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from testforge_sim_hardware.config import ServerConfig
from testforge_sim_hardware.drivers import create_driver
from testforge_sim_hardware.runtime import BearerMiddleware, TestForgeSimRuntime
from testforge_sim_hardware.shutdown import prepare_safe_shutdown


def runtime() -> TestForgeSimRuntime:
    config = ServerConfig.model_validate({
        "serverId": "SIM_AI_MCP",
        "hardwareId": "SIM_PC.SIM_AI_0",
        "label": "AI",
        "manufacturer": "TestForge",
        "model": "Virtual AI",
        "host": "127.0.0.1",
        "port": 8101,
        "token": "secret",
        "driver": {"kind": "analog_input", "values": [1, 2, 3, 4]},
    })
    return TestForgeSimRuntime(config, create_driver(config))


class RuntimeTests(unittest.TestCase):
    def test_summary_contains_exactly_the_configured_identity(self) -> None:
        host = runtime()
        host.driver.open()
        summary = host.summary()
        self.assertEqual(summary.hardwareId, "SIM_PC.SIM_AI_0")
        self.assertEqual(summary.state, "open")
        self.assertEqual(summary.capabilities, ("read_analog_input", "read_all_analog_inputs"))

    def test_invoke_unwraps_success_and_normalizes_errors(self) -> None:
        host = runtime()
        host.occupancy.action("SIM_PC.SIM_AI_0", "acquire", "holder", "Human", "lease")
        success = host.invoke("SIM_PC.SIM_AI_0", "lease", lambda: {"value": 1})
        failure = host.invoke("OTHER", "lease", lambda: None)
        self.assertTrue(success["ok"])
        self.assertEqual(success["data"], {"value": 1})
        self.assertFalse(failure["ok"])
        self.assertEqual(failure["error"]["category"], "invalid_argument")

    def test_hardware_call_requires_current_occupancy_lease(self) -> None:
        host = runtime()
        denied = host.invoke("SIM_PC.SIM_AI_0", None, lambda: {"value": 1})
        host.occupancy.action("SIM_PC.SIM_AI_0", "acquire", "holder", "Human", "lease")
        stale = host.invoke("SIM_PC.SIM_AI_0", "old", lambda: {"value": 1})
        allowed = host.invoke("SIM_PC.SIM_AI_0", "lease", lambda: {"value": 1})
        self.assertEqual(denied["error"]["category"], "occupancy_required")
        self.assertEqual(stale["error"]["category"], "occupancy_required")
        self.assertTrue(allowed["ok"])

    def test_health_is_public_but_other_routes_require_bearer_token(self) -> None:
        async def ok(_: Request) -> JSONResponse:
            return JSONResponse({"ok": True})

        app = Starlette(routes=[Route("/health", ok), Route("/mcp", ok)])
        app.add_middleware(BearerMiddleware, token="secret")

        async def scenario() -> list[int]:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return [
                    (await client.get("/health")).status_code,
                    (await client.get("/mcp")).status_code,
                    (await client.get("/mcp", headers={"Authorization": "Bearer wrong"})).status_code,
                    (await client.get("/mcp", headers={"Authorization": "Bearer secret"})).status_code,
                ]

        self.assertEqual(asyncio.run(scenario()), [200, 401, 401, 200])

    def test_safe_shutdown_calls_driver_then_schedules_exit(self) -> None:
        host = runtime()
        host.driver.open()
        exits: list[bool] = []

        async def scenario() -> dict:
            result = await prepare_safe_shutdown(
                host.driver,
                host.config.hardware_id,
                lambda exc: {"message": str(exc)},
                host.now,
                process_exit=lambda: exits.append(True),
                delay=0,
            )
            await asyncio.sleep(0.01)
            return result

        result = asyncio.run(scenario())
        self.assertTrue(result["ok"])
        self.assertEqual(exits, [True])


if __name__ == "__main__":
    unittest.main()
