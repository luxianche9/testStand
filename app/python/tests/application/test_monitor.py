"""Monitor panel operations: which streams the devices offer, which channels the panel shows."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from teststand_backend.application import HUMAN_REQUEST_CONTEXT as HUMAN
from teststand_backend.application import DefaultAuthorizer, MonitorApplication
from teststand_backend.devices import DeviceCatalogService, DeviceStore
from teststand_backend.projects import ProjectService
from teststand_backend.storage import SettingsStore
from teststand_backend.wiring import ProjectWiringService

Json = dict[str, Any]

AI0: Json = {"hardwareId": "CARD", "streamId": "ai0"}
AI1: Json = {"hardwareId": "CARD", "streamId": "ai1"}


def managed(hardware_id: str, label: str) -> Json:
    """A device instance; its hardware record is derived as ``managed`` and takes this label."""
    return {
        "deviceId": hardware_id + "_DEVICE",
        "label": label,
        "hardwareId": hardware_id,
        "type": "pci1710l",
        "enabled": True,
    }


async def fixture(root: Path, *, known: bool = True) -> tuple[MonitorApplication, ProjectService]:
    """The monitor over one managed card (``known``: its streams were listed) and a passive DUT."""
    settings = SettingsStore(str(root / "settings.json"))
    await settings.initialize()
    projects = ProjectService(settings)
    await projects.initialize()
    project_root = root / "project"
    project_root.mkdir()
    await projects.initialize_folder(str(project_root))
    store = DeviceStore(str(root / "devices"))
    await store.initialize()
    catalog = DeviceCatalogService(store)
    await store.save_device(managed("CARD", "采集卡"))
    await catalog.save_hardware(
        {
            "formatVersion": 2,
            "hardwareId": "DUT",
            "label": "被测件",
            "kind": "passive",
            "ports": [],
        }
    )
    # The monitor only calls notify_project_changed, which needs no initialize().
    wiring = ProjectWiringService(projects, catalog)
    streams = [{"id": "ai0"}, {"id": "ai1"}]
    devices = Mock(
        known_streams=lambda hardware_id: streams if known and hardware_id == "CARD" else None
    )
    monitor = MonitorApplication(DefaultAuthorizer(), projects, wiring, catalog, devices)
    return monitor, projects


async def test_streams_lists_managed_devices_only(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    assert monitor.streams(HUMAN) == [
        {
            "hardwareId": "CARD",
            "label": "采集卡",
            "known": True,
            "streams": [{"id": "ai0"}, {"id": "ai1"}],
        }
    ]


async def test_streams_marks_a_device_never_connected_as_unknown(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path, known=False)
    assert monitor.streams(HUMAN) == [
        {"hardwareId": "CARD", "label": "采集卡", "known": False, "streams": []}
    ]


async def test_add_appends_and_get_returns_the_panel(tmp_path: Path) -> None:
    monitor, projects = await fixture(tmp_path)
    assert monitor.get(HUMAN) == {"channels": []}
    assert await monitor.update(HUMAN, {"add": [AI0]}) == {"channels": [AI0]}
    assert await monitor.update(HUMAN, {"add": [AI1]}) == {"channels": [AI0, AI1]}
    assert monitor.get(HUMAN) == {"channels": [AI0, AI1]}
    assert projects.monitor() == {"channels": [AI0, AI1]}


async def test_add_ignores_a_channel_already_shown(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    await monitor.update(HUMAN, {"add": [AI0]})
    assert await monitor.update(HUMAN, {"add": [AI0]}) == {"channels": [AI0]}


async def test_remove_applies_after_channels(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    result = await monitor.update(HUMAN, {"channels": [AI0, AI1], "remove": [AI0]})
    assert result == {"channels": [AI1]}


async def test_remove_then_add_puts_the_channel_last(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    await monitor.update(HUMAN, {"channels": [AI0, AI1]})
    assert await monitor.update(HUMAN, {"remove": [AI0], "add": [AI0]}) == {"channels": [AI1, AI0]}


async def test_removing_a_channel_that_is_not_shown_is_a_no_op(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    assert await monitor.update(HUMAN, {"remove": [AI0]}) == {"channels": []}


async def test_channels_replaces_the_whole_list(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    await monitor.update(HUMAN, {"add": [AI0]})
    assert await monitor.update(HUMAN, {"channels": [AI1]}) == {"channels": [AI1]}


async def test_the_same_channel_twice_is_rejected(tmp_path: Path) -> None:
    monitor, projects = await fixture(tmp_path)
    with pytest.raises(Exception, match="CARD.ai0 is shown twice"):
        await monitor.update(HUMAN, {"channels": [AI0, AI0]})
    assert projects.monitor() == {"channels": []}


async def test_a_stream_of_an_unregistered_device_is_rejected(tmp_path: Path) -> None:
    monitor, projects = await fixture(tmp_path)
    with pytest.raises(Exception, match="GHOST is not a registered device"):
        await monitor.update(HUMAN, {"add": [{"hardwareId": "GHOST", "streamId": "ai0"}]})
    assert projects.monitor() == {"channels": []}


async def test_a_stream_of_a_passive_device_is_rejected(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    with pytest.raises(Exception, match="DUT is not a registered device"):
        await monitor.update(HUMAN, {"add": [{"hardwareId": "DUT", "streamId": "ai0"}]})


async def test_a_stream_the_device_does_not_declare_is_rejected(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    with pytest.raises(Exception, match="CARD declares no stream ai9"):
        await monitor.update(HUMAN, {"add": [{"hardwareId": "CARD", "streamId": "ai9"}]})


async def test_any_stream_is_accepted_while_the_device_is_unknown(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path, known=False)
    assert await monitor.update(HUMAN, {"add": [{"hardwareId": "CARD", "streamId": "ai9"}]}) == {
        "channels": [{"hardwareId": "CARD", "streamId": "ai9"}]
    }
