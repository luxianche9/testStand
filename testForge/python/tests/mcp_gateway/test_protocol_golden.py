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
                body["result"]["tools"] = [tool["name"] for tool in body["result"]["tools"]]
            assert {"status": response.status_code, "body": body} == case["expected"]
    finally:
        await gateway.stop()
