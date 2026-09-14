from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.devices.mcp_client import McpHttpTransport


async def test_sdk_envelope_retains_content_without_changing_existing_callers() -> None:
    pool = McpHttpTransport(Mock())
    envelope: dict[str, Any] = {
        "content": [{"type": "image", "mimeType": "image/png", "data": "YWJj"}],
        "structuredContent": {"ok": True, "data": {"value": 42}},
        "isError": False,
    }
    client = Mock(call_tool=AsyncMock(return_value=envelope))
    pool.sessions["S"] = {"client": client, "validators": {}}
    assert await pool.call_remote("S", "read", {}) == {"value": 42}
    assert await pool.call_remote("S", "read", {}, {"preserveEnvelope": True}) == envelope
    assert client.call_tool.call_count == 2
    assert "preserveEnvelope" not in client.call_tool.call_args.kwargs["options"]
    client.call_tool.return_value = {
        "content": [],
        "structuredContent": {
            "ok": False,
            "error": {
                "category": "unavailable",
                "message": "offline",
                "details": {"hardwareId": "H"},
            },
        },
    }
    with pytest.raises(AppError) as failure:
        await pool.call_remote("S", "read", {}, {"preserveEnvelope": True})
    assert failure.value.category == "unavailable"
