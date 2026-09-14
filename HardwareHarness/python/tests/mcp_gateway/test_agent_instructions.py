from __future__ import annotations

import httpx

from .test_boundaries import _HEADERS, _INITIALIZE, make_gateway, result_body


async def test_initialize_teaches_agent_application_workflow_and_sdk_boundaries() -> None:
    gateway, _ = make_gateway()
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=_HEADERS) as client:
            response = await client.post(gateway.status()["endpoint"], json=_INITIALIZE)
        assert response.status_code == 200
        instructions = result_body(response)["instructions"]
        ordered_steps = [
            "1. 检查设备能力与资料",
            "2. 处理接线和占用",
            "3. 编写流程与页面",
            "4. 使用模拟硬件测试",
            "5. 启动真实执行",
            "6. 检查日志",
        ]
        positions = [instructions.index(step) for step in ordered_steps]
        assert positions == sorted(positions)
        for requirement in (
            ".hardwareharness/docs/hardwareharness-sdk.md",
            "main(inputs)",
            "call",
            "acall",
            "step",
            "log",
            "measurement",
            "attachment",
            "主动硬件",
            "不提供业务上下文、占用、接线、人工确认、项目管理或 Run 管理接口",
            "不自动申请占用、不等待授权、不重放硬件调用",
            "远端结果未知",
            "get_python_run_events",
        ):
            assert requirement in instructions
    finally:
        await gateway.stop()
