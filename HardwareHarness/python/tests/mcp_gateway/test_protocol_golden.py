from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from .test_boundaries import _HEADERS, _INITIALIZE, make_gateway

CASES: list[dict[str, Any]] = json.loads(
    Path(__file__).with_name("protocol-golden.json").read_text()
)


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
async def test_unmodified_ts_gateway_protocol_golden(case: dict[str, Any]) -> None:
    gateway, _ = make_gateway()
    await gateway.start()
    try:
        async with httpx.AsyncClient(headers=_HEADERS) as client:
            url = gateway.status()["endpoint"]
            if case.get("session"):
                opened = await client.post(url, json=_INITIALIZE)
                client.headers["mcp-session-id"] = opened.headers["mcp-session-id"]
            response = await client.request(
                case.get("method", "POST"),
                url,
                headers=case.get("headers", {}),
                **({"json": case["body"]} if "body" in case else {}),
            )
            body: Any
            if response.headers.get("content-type", "").startswith("text/event-stream"):
                messages = [
                    json.loads(line[6:])
                    for line in response.text.splitlines()
                    if line.startswith("data: ")
                ]
                body = messages if len(messages) > 1 else messages[0]
            else:
                body = response.json() if response.content else None
            if case["name"] == "toolsList":
                names = [tool["name"] for tool in body["result"]["tools"]]
                assert names[:4] == [
                    "get_project",
                    "initialize_project",
                    "open_project",
                    "save_project",
                ]
                from hardwareharness_backend.mcp_gateway.tool_registry import (
                    BUILTIN_TOOL_DEFINITIONS,
                )

                replacement = {
                    item.tool["name"]
                    for item in BUILTIN_TOOL_DEFINITIONS
                    if item.capability.startswith("references.")
                }
                replacement.update(
                    {
                        "get_agent_context",
                        "get_execution_availability",
                        "read_reference",
                        "register_reference",
                        "get_tool_contract",
                        "wait_for_status",
                        "import_firmware_artifact",
                    }
                )
                assert replacement.issubset(names)
                assert not any("occupancy" in name for name in names)
                legacy_test_tools = {
                    "get_test_task",
                    "update_test_task",
                    "cancel_test_run",
                }
                assert not legacy_test_tools.intersection(names)
                testing_tools = {
                    "list_test_plans",
                    "get_test_plan",
                    "get_test_step_catalog",
                    "list_test_device_tools",
                    "validate_test_plan",
                    "get_test_run",
                    "read_test_run_results",
                    "wait_for_test_run",
                    "create_test_plan",
                    "apply_test_plan_operations",
                    "start_test_run",
                    "pause_test_run",
                    "resume_test_run",
                    "abort_test_run",
                }
                assert testing_tools.issubset(names)
                replacement.update(testing_tools)
                # Compare retained tools and the unchanged protocol envelope to the fixed golden.
                body["result"]["tools"] = [name for name in names[4:] if name not in replacement]
                expected = json.loads(json.dumps(case["expected"]))
                expected["body"]["result"]["tools"] = [
                    name
                    for name in expected["body"]["result"]["tools"]
                    if "occupancy" not in name
                    and name not in legacy_test_tools
                    and name not in testing_tools
                ]
                assert {"status": response.status_code, "body": body} == expected
                return
            assert {"status": response.status_code, "body": body} == case["expected"]
    finally:
        await gateway.stop()
