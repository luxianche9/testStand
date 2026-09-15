from __future__ import annotations

import httpx

from hardwareharness_backend.mcp_gateway.agent_instructions import AGENT_INSTRUCTIONS

from .test_boundaries import _HEADERS, _INITIALIZE, make_gateway, result_body


async def test_initialize_teaches_agent_python_program_and_sdk_boundaries() -> None:
    gateway, _ = make_gateway()
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=_HEADERS) as client:
            response = await client.post(gateway.status()["endpoint"], json=_INITIALIZE)
        assert response.status_code == 200
        instructions = result_body(response)["instructions"]
        assert instructions == AGENT_INSTRUCTIONS
        for requirement in (
            "发行版环境",
            "get_agent_context",
            "get_tool_contract",
            "read_reference",
            "create_workspace_file",
            "validate_python_file",
            "expectedHash",
            "main(inputs)",
            "call",
            "acall",
            "step",
            "log",
            "measurement",
            "attachment",
            "主动硬件",
            "不管理项目、接线或 Run",
            "平台不会自动重放硬件调用",
            "结果未知",
            'result_mode="envelope"',
            'result_mode="data"',
            "passed=false",
            ".hardwareharness/scripts",
            "用户提供的项目代码、固件源码",
        ):
            assert requirement in instructions
        assert ".hardwareharness/workflows" not in instructions
        assert "get_application_logs" not in instructions
        for obsolete_directive in ("模拟", "mock", "simulate", "simulation"):
            assert obsolete_directive not in instructions.lower()
    finally:
        await gateway.stop()
