from __future__ import annotations

from unittest.mock import Mock

import pytest

from hardwareharness_backend.contracts.errors import AppError

from .test_agent_services import invoke


async def test_waiting_for_service_uses_cached_status_and_never_replays_lifecycle() -> None:
    app = Mock()
    app.system.dashboard.return_value = {"devices": [{"deviceId": "S"}], "deviceStatuses": []}
    waiting = await invoke(app, "wait_for_status", {"kind": "service", "id": "S", "timeoutMs": 0})
    assert waiting["timedOut"] and not waiting["terminal"]
    initial_revision = waiting["revision"]
    app.system.dashboard.return_value["deviceStatuses"] = [
        {
            "deviceId": "S",
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
    app.system.dashboard.return_value["deviceStatuses"][0]["service"]["checkedAt"] = "later"
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
    app.devices.device_action.assert_not_called()
    app.devices.refresh_device.assert_not_called()
    with pytest.raises(AppError, match="Unknown device"):
        await invoke(app, "wait_for_status", {"kind": "service", "id": "absent", "timeoutMs": 0})
