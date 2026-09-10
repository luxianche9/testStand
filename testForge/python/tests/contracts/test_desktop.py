from testforge_backend.contracts.desktop import TESTFORGE_EVENT_NAMES, TESTFORGE_IPC


def test_desktop_channel_names() -> None:
    assert list(TESTFORGE_IPC) == [
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
    assert TESTFORGE_IPC["devices"]["executeSsh"] == "testforge:devices:ssh-execute"
    assert TESTFORGE_IPC["devices"]["readServerLogs"] == "testforge:devices:server-logs"
    assert TESTFORGE_IPC["agents"]["startOpenCode"] == "testforge:agents:opencode-start"
    assert TESTFORGE_EVENT_NAMES == (
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
    channels = [value for group in TESTFORGE_IPC.values() for value in group.values()]
    assert len(channels) == len(set(channels))
