"""Project protocol bindings: derived field streams are live, listed and used by plans."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from teststand_backend.application import DefaultAuthorizer
from teststand_backend.application.protocols import ProtocolsApplication
from teststand_backend.application.streams import StreamsApplication
from teststand_backend.contracts.errors import AppError
from teststand_backend.projects.icd_library import IcdLibrary
from teststand_backend.projects.protocol_bindings import ProjectProtocols
from teststand_backend.streams.live import LiveStreams
from teststand_backend.streams.source import StreamSources
from teststand_backend.testing import TestPlanStore

from ..protocol.icd_fixtures import DUT_CMD_YAML, status_frame
from ..streams.fake_service import FakeStreamService

HUMAN = {"actor": "human"}
BINDING = {"icd": "dut_cmd", "alias": "dut", "source": {"hardwareId": "dev", "streamId": "rx"}}


class Projects:
    """The slice of ``ProjectService`` the protocol bindings use."""

    def __init__(self, root: Path, protocols: list[dict[str, Any]] | None = None) -> None:
        self.root = root
        self.bindings = list(protocols or [])
        self.changes = 0

    def session(self) -> dict[str, str]:
        return {"projectId": "project", "rootPath": str(self.root)}

    def document(self) -> dict[str, Any]:
        return {"rootPath": str(self.root)}

    def protocols(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self.bindings]

    def update_protocols(self, protocols: list[dict[str, Any]]) -> None:
        self.bindings = list(protocols)
        self.changes += 1


def project(tmp_path: Path, *bindings: dict[str, Any]) -> tuple[Projects, ProjectProtocols]:
    (tmp_path / "icd").mkdir(exist_ok=True)
    (tmp_path / "icd" / "dut_cmd.icd.yaml").write_text(DUT_CMD_YAML, encoding="utf-8")
    projects = Projects(tmp_path, list(bindings))
    return projects, ProjectProtocols(projects, IcdLibrary(projects))


def test_bindings_list_their_field_streams_on_the_source_hardware(tmp_path: Path) -> None:
    _, protocols = project(tmp_path, BINDING)
    streams = {item["id"]: item for item in protocols.streams("dev")}
    assert streams["dut.status.voltage"]["type"] == "scalar"
    assert streams["dut.status.voltage"]["unit"] == "V"
    assert streams["dut.status.voltage"]["derived"] == {
        "icd": "dut_cmd",
        "alias": "dut",
        "sourceStreamId": "rx",
        "message": "status",
        "field": "voltage",
    }
    assert "dut.status" not in streams and "dut.$errors" not in streams  # followed by name only
    assert protocols.streams("other") == []
    assert protocols.derived("dev", "dut.status") is not None
    assert protocols.derived("dev", "rx") is None
    assert protocols.derived("other", "dut.status.voltage") is None


def test_a_binding_without_a_valid_icd_derives_nothing_and_says_why(tmp_path: Path) -> None:
    _, protocols = project(tmp_path, {**BINDING, "icd": "missing"})
    assert protocols.streams("dev") == []
    [described] = protocols.describe()
    assert described["ok"] is False and "missing" in described["error"]


async def test_derived_fields_are_live_and_readable_as_latest_values(tmp_path: Path) -> None:
    _, protocols = project(tmp_path, BINDING)
    async with FakeStreamService({"rx": "bytes"}) as service:
        sources = StreamSources(lambda _hardware_id: service, protocols.derived)
        live = LiveStreams(sources, tmp_path / "live", frame_s=0.02, linger_s=0.5)
        (tmp_path / "live").mkdir()
        key = "dev__dut.status.voltage"
        first = await live.latest([key])
        assert first["streams"][key]["record"] is None
        frame = status_frame(voltage=1234)
        service.publish("rx", dir="rx", data=frame[:6].hex())  # split across two records
        service.publish("rx", dir="rx", data=frame[6:].hex())

        async def value() -> dict[str, Any]:
            while True:
                entry = (await live.latest([key]))["streams"][key]
                if entry["record"] is not None:
                    return dict(entry)
                await asyncio.sleep(0.02)

        entry = await asyncio.wait_for(value(), 5)
        assert entry["type"] == "scalar"
        assert entry["record"]["v"] == pytest.approx(12.34)
        await live.close()


def application(projects: Projects, protocols: ProjectProtocols) -> ProtocolsApplication:
    catalog = SimpleNamespace(
        get_hardware=lambda hardware_id: {
            "hardwareId": hardware_id,
            "kind": "passive" if hardware_id == "fixture" else "managed",
        }
    )
    devices = SimpleNamespace(
        known_streams=lambda _hardware_id: [
            {"id": "rx", "type": "bytes"},
            {"id": "ai0", "type": "scalar"},
        ]
    )
    wiring = SimpleNamespace(notify_project_changed=lambda: None)
    parts: tuple[Any, ...] = (projects, protocols, wiring, catalog, devices)
    return ProtocolsApplication(DefaultAuthorizer(), *parts)


def test_update_adds_changes_and_removes_bindings(tmp_path: Path) -> None:
    projects, protocols = project(tmp_path)
    app = application(projects, protocols)
    assert app.bindings(HUMAN) == []
    [added] = app.update(HUMAN, {"operations": [{"op": "add", **BINDING}]})
    assert added["ok"] is True and projects.bindings == [BINDING]
    assert any(item["streamId"] == "dut.status.voltage" for item in added["streams"])
    app.update(HUMAN, {"operations": [{"op": "update", "alias": "dut", "icd": "dut_cmd"}]})
    assert app.update(HUMAN, {"operations": [{"op": "remove", "alias": "dut"}]}) == []
    assert projects.changes == 3


@pytest.mark.parametrize(
    ("operation", "message"),
    [
        ({"op": "add", **BINDING, "icd": "missing"}, "not found"),
        ({"op": "add", **BINDING, "source": {"hardwareId": "dev", "streamId": "ai0"}}, "decodes"),
        ({"op": "add", **BINDING, "source": {"hardwareId": "dev", "streamId": "nope"}}, "nope"),
        (
            {"op": "add", **BINDING, "source": {"hardwareId": "fixture", "streamId": "rx"}},
            "passive",
        ),
        ({"op": "update", "alias": "other", "icd": "dut_cmd"}, "No protocol binding"),
        ({"op": "add", "alias": "dut"}, "needs icd and source"),
    ],
)
def test_update_refuses_bindings_that_cannot_decode(
    tmp_path: Path, operation: dict[str, Any], message: str
) -> None:
    projects, protocols = project(tmp_path)
    with pytest.raises(AppError, match=message):
        application(projects, protocols).update(HUMAN, {"operations": [operation]})
    assert projects.changes == 0


def test_a_device_never_connected_is_checked_when_it_is_used(tmp_path: Path) -> None:
    projects, protocols = project(tmp_path)
    app = application(projects, protocols)
    app.devices = SimpleNamespace(known_streams=lambda _hardware_id: None)  # type: ignore[assignment]
    [binding] = app.update(HUMAN, {"operations": [{"op": "add", **BINDING}]})
    assert binding["ok"] is True


async def test_stream_operations_list_fields_and_read_latest_values(tmp_path: Path) -> None:
    _, protocols = project(tmp_path, BINDING)

    async def list_streams(_hardware_id: str) -> list[dict[str, Any]]:
        return [{"id": "rx", "type": "bytes"}]

    async def latest(keys: list[str]) -> dict[str, Any]:
        return {"t": 0, "streams": {key: {"record": None} for key in keys}}

    devices = SimpleNamespace(list_streams=list_streams)
    live = SimpleNamespace(latest=latest)
    parts: tuple[Any, ...] = (devices, live)
    streams = StreamsApplication(DefaultAuthorizer(), *parts, protocols=protocols)
    listed = [item["id"] for item in await streams.list_streams(HUMAN, "dev")]
    assert listed[0] == "rx" and "dut.status.voltage" in listed
    assert (await streams.latest(HUMAN, ["dev__rx"]))["streams"] == {"dev__rx": {"record": None}}


def test_update_refuses_a_second_binding_with_the_same_alias(tmp_path: Path) -> None:
    projects, protocols = project(tmp_path, BINDING)
    with pytest.raises(AppError, match="already bound"):
        application(projects, protocols).update(HUMAN, {"operations": [{"op": "add", **BINDING}]})


async def test_plans_decode_with_the_project_bindings_and_never_store_them(
    tmp_path: Path,
) -> None:
    projects, protocols = project(tmp_path, BINDING)
    resolver = SimpleNamespace(icd=protocols.icds.get, streams=lambda _id: {"rx": "bytes"})
    store = TestPlanStore(projects, resolver)
    created = await store.create({"id": "alpha", "name": "Alpha"})
    assert "protocolBindings" not in created["plan"] and created["issues"] == []
    compiled = store.compile("alpha")
    assert compiled["compiledPlan"]["protocolBindings"] == [BINDING]
    assert "dut_cmd" in compiled["compiledPlan"]["icds"]
    projects.bindings = []
    assert store.compile("alpha")["compiledPlan"]["icds"] == {}
    text = (tmp_path / ".teststand" / "plans" / "alpha.hhplan.yaml").read_text(encoding="utf-8")
    assert "protocolBindings" not in text
