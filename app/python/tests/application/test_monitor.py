"""Monitor workspace operations: which streams the devices offer, which panels show them."""

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
DI: Json = {"hardwareId": "CARD", "streamId": "di"}
RX: Json = {"hardwareId": "CARD", "streamId": "rx"}


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
    streams = [
        {"id": "ai0", "type": "scalar"},
        {"id": "ai1", "type": "scalar"},
        {"id": "di", "type": "bits"},
        {"id": "rx", "type": "bytes"},
    ]
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
            "streams": [
                {"id": "ai0", "type": "scalar"},
                {"id": "ai1", "type": "scalar"},
                {"id": "di", "type": "bits"},
                {"id": "rx", "type": "bytes"},
            ],
        }
    ]


async def test_streams_marks_a_device_never_connected_as_unknown(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path, known=False)
    assert monitor.streams(HUMAN) == [
        {"hardwareId": "CARD", "label": "采集卡", "known": False, "streams": []}
    ]


def shown(monitor: Json) -> list[tuple[str, str, list[Json]]]:
    return [(panel["id"], panel["type"], panel["sources"]) for panel in monitor["panels"]]


async def test_an_empty_project_has_no_panels(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    assert monitor.get(HUMAN) == {"panels": [], "layout": None}


async def test_add_puts_each_stream_on_a_panel_that_draws_its_type(tmp_path: Path) -> None:
    monitor, projects = await fixture(tmp_path)
    result = await monitor.update(HUMAN, {"add": [AI0, RX, DI, AI1]})
    assert shown(result) == [("scope", "scope", [AI0, DI, AI1]), ("terminal", "terminal", [RX])]
    assert projects.monitor() == result


async def test_add_skips_a_stream_some_panel_already_shows(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    await monitor.update(
        HUMAN, {"operations": [{"op": "addPanel", "panel": {"type": "digital", "sources": [DI]}}]}
    )
    assert shown(await monitor.update(HUMAN, {"add": [DI]})) == [("digital", "digital", [DI])]


async def test_remove_takes_a_stream_off_every_panel(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    await monitor.update(
        HUMAN,
        {
            "operations": [
                {"op": "addPanel", "panel": {"type": "scope", "sources": [AI0, DI]}},
                {"op": "addPanel", "panel": {"type": "digital", "sources": [DI]}},
            ]
        },
    )
    result = await monitor.update(HUMAN, {"remove": [DI, AI1]})
    assert shown(result) == [("scope", "scope", [AI0]), ("digital", "digital", [])]


async def test_panel_operations_apply_in_order(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    result = await monitor.update(
        HUMAN,
        {
            "operations": [
                {"op": "addPanel", "panel": {"id": "ai", "type": "scope", "title": "AI"}},
                {
                    "op": "addPanel",
                    "panel": {"type": "terminal", "sources": [RX]},
                    "placement": {"referenceId": "ai", "direction": "below"},
                },
                {"op": "addSources", "panelId": "ai", "sources": [AI0, AI1, AI0]},
                {"op": "removeSources", "panelId": "ai", "sources": [AI0]},
                {"op": "updatePanel", "panelId": "ai", "settings": {"timeDivMs": 10}},
                {"op": "updatePanel", "panelId": "ai", "title": "模拟量", "settings": {"y": 1}},
            ]
        },
    )
    assert result["panels"] == [
        {
            "id": "ai",
            "type": "scope",
            "title": "模拟量",
            "sources": [AI1],
            "settings": {"timeDivMs": 10, "y": 1},
        },
        {
            "id": "terminal",
            "type": "terminal",
            "sources": [RX],
            "settings": {},
            "placement": {"referenceId": "ai", "direction": "below"},
        },
    ]
    result = await monitor.update(HUMAN, {"operations": [{"op": "removePanel", "panelId": "ai"}]})
    assert shown(result) == [("terminal", "terminal", [RX])]


async def test_generated_panel_ids_do_not_collide(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    add = {"op": "addPanel", "panel": {"type": "scope"}}
    result = await monitor.update(HUMAN, {"operations": [add, add, add]})
    assert [panel["id"] for panel in result["panels"]] == ["scope", "scope2", "scope3"]


async def test_a_duplicate_panel_id_is_rejected(tmp_path: Path) -> None:
    monitor, projects = await fixture(tmp_path)
    add = {"op": "addPanel", "panel": {"id": "x", "type": "scope"}}
    with pytest.raises(Exception, match="panel x already exists"):
        await monitor.update(HUMAN, {"operations": [add, add]})
    assert projects.monitor()["panels"] == []


async def test_an_unknown_panel_is_rejected_with_the_existing_ids(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    await monitor.update(HUMAN, {"add": [AI0]})
    with pytest.raises(Exception, match="no panel nope; panels: scope"):
        await monitor.update(HUMAN, {"operations": [{"op": "removePanel", "panelId": "nope"}]})
    with pytest.raises(Exception, match="no panel nope"):
        await monitor.update(
            HUMAN,
            {
                "operations": [
                    {
                        "op": "addPanel",
                        "panel": {"type": "scope"},
                        "placement": {"referenceId": "nope", "direction": "right"},
                    }
                ]
            },
        )


async def test_a_stream_the_panel_cannot_draw_is_rejected(tmp_path: Path) -> None:
    monitor, projects = await fixture(tmp_path)
    with pytest.raises(Exception, match="CARD.rx is a bytes stream; a scope panel draws"):
        await monitor.update(
            HUMAN, {"operations": [{"op": "addPanel", "panel": {"type": "scope", "sources": [RX]}}]}
        )
    with pytest.raises(Exception, match="a results panel draws no streams"):
        await monitor.update(
            HUMAN,
            {"operations": [{"op": "addPanel", "panel": {"type": "results", "sources": [AI0]}}]},
        )
    assert projects.monitor()["panels"] == []


async def test_layout_is_replaced_and_kept(tmp_path: Path) -> None:
    monitor, _ = await fixture(tmp_path)
    layout = {"grid": {"root": {}}, "panels": {}}
    assert (await monitor.update(HUMAN, {"layout": layout}))["layout"] == layout
    assert (await monitor.update(HUMAN, {"add": [AI0]}))["layout"] == layout
    assert (await monitor.update(HUMAN, {"layout": None}))["layout"] is None


async def test_a_stream_of_an_unregistered_device_is_rejected(tmp_path: Path) -> None:
    monitor, projects = await fixture(tmp_path)
    with pytest.raises(Exception, match="GHOST is not a registered device"):
        await monitor.update(HUMAN, {"add": [{"hardwareId": "GHOST", "streamId": "ai0"}]})
    assert projects.monitor()["panels"] == []


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
    ai9 = {"hardwareId": "CARD", "streamId": "ai9"}
    assert shown(await monitor.update(HUMAN, {"add": [ai9]})) == [("scope", "scope", [ai9])]
