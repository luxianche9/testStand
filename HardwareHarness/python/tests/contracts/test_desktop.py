from hardwareharness_backend.contracts.desktop import (
    HARDWAREHARNESS_EVENT_NAMES,
    HARDWAREHARNESS_IPC,
)


def test_desktop_channel_names() -> None:
    assert list(HARDWAREHARNESS_IPC) == [
        "system",
        "devices",
        "projects",
        "wiring",
        "orchestration",
        "manual",
        "occupancy",
        "agents",
        "settings",
        "window",
    ]
    assert HARDWAREHARNESS_IPC["devices"]["executeSsh"] == "hardwareharness:devices:ssh-execute"
    assert HARDWAREHARNESS_IPC["devices"]["readServerLogs"] == "hardwareharness:devices:server-logs"
    assert HARDWAREHARNESS_IPC["agents"]["startOpenCode"] == "hardwareharness:agents:opencode-start"
    assert HARDWAREHARNESS_EVENT_NAMES == (
        "availability",
        "execution",
        "occupancy",
        "occupancyRequest",
        "run",
        "nodeRun",
        "wiringTask",
        "operator",
        "project",
        "opencode",
        "window-state",
    )
    channels = [value for group in HARDWAREHARNESS_IPC.values() for value in group.values()]
    assert len(channels) == len(set(channels))
