from __future__ import annotations

import base64
import json
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.contracts.errors import AppError

from .test_agent_services import invoke


async def test_waiting_for_service_uses_cached_status_and_never_replays_lifecycle() -> None:
    app = Mock()
    app.system.dashboard.return_value = {"servers": [{"serverId": "S"}], "serverStatuses": []}
    waiting = await invoke(app, "wait_for_status", {"kind": "service", "id": "S", "timeoutMs": 0})
    assert waiting["timedOut"] and not waiting["terminal"]
    initial_revision = waiting["revision"]
    app.system.dashboard.return_value["serverStatuses"] = [
        {
            "serverId": "S",
            "service": {"state": "online", "checkedAt": "first"},
            "transport": {"state": "offline", "checkedAt": "first"},
        }
    ]
    changed = await invoke(
        app,
        "wait_for_status",
        {
            "kind": "service",
            "id": "S",
            "revision": initial_revision,
            "timeoutMs": 0,
        },
    )
    assert changed["changed"] and changed["terminal"]
    app.system.dashboard.return_value["serverStatuses"][0]["service"]["checkedAt"] = "later"
    stable = await invoke(
        app,
        "wait_for_status",
        {
            "kind": "service",
            "id": "S",
            "revision": changed["revision"],
            "timeoutMs": 0,
        },
    )
    assert not stable["changed"]
    assert stable["status"]["transport"]["state"] == "offline"
    app.devices.server_action.assert_not_called()
    app.devices.refresh_server.assert_not_called()
    with pytest.raises(AppError, match="Unknown MCP server"):
        await invoke(app, "wait_for_status", {"kind": "service", "id": "absent", "timeoutMs": 0})


async def test_run_source_tampering_is_reported_instead_of_misattributed_to_original_run() -> None:
    app = Mock()
    app.applications.get_run = AsyncMock(
        return_value={
            "run": {"sourceHashes": {"scripts/main.py": "original"}},
        }
    )
    app.applications.read_run_source = AsyncMock(
        return_value={
            "path": "scripts/main.py",
            "content": "changed",
            "hash": "different",
        }
    )
    with pytest.raises(AppError, match="original snapshot") as caught:
        await invoke(app, "read_python_run_source", {"runId": "R", "path": "scripts/main.py"})
    assert caught.value.category == "conflict"


async def test_event_artifact_roundtrip_and_stale_reference_failures() -> None:
    app = Mock()
    event = {"sequence": 51, "type": "hardware.completed", "data": {"observed": "证据"}}
    app.applications.run_events = AsyncMock(return_value=[event])
    first = await invoke(
        app,
        "read_python_run_artifact",
        {
            "runId": "R",
            "artifactId": "event:51",
            "limit": 10,
        },
    )
    assert first["hasMore"] and first["nextOffset"] == 10
    rest = await invoke(
        app,
        "read_python_run_artifact",
        {
            "runId": "R",
            "artifactId": "event:51",
            "offset": 10,
        },
    )
    encoded = base64.b64decode(first["contentBase64"]) + base64.b64decode(rest["contentBase64"])
    assert json.loads(encoded) == event
    with pytest.raises(AppError, match="event:<sequence>"):
        await invoke(app, "read_python_run_artifact", {"runId": "R", "artifactId": "event:nope"})
    with pytest.raises(AppError, match="does not exist"):
        await invoke(app, "read_python_run_artifact", {"runId": "R", "artifactId": "event:50"})
    app.applications.run_events.return_value = []
    with pytest.raises(AppError, match="does not exist"):
        await invoke(app, "read_python_run_artifact", {"runId": "R", "artifactId": "event:51"})
