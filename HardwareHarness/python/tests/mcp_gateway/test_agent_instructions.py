from __future__ import annotations

import httpx

from hardwareharness_backend.mcp_gateway.agent_instructions import AGENT_INSTRUCTIONS

from .test_boundaries import _HEADERS, _INITIALIZE, make_gateway, result_body


async def test_initialize_uses_shared_hardware_development_prompt() -> None:
    gateway, _ = make_gateway()
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=_HEADERS) as client:
            response = await client.post(gateway.status()["endpoint"], json=_INITIALIZE)
        assert response.status_code == 200
        instructions = result_body(response)["instructions"]
        assert instructions == AGENT_INSTRUCTIONS
        assert instructions.strip()
    finally:
        await gateway.stop()
