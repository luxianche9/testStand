import inspect
import itertools
import json
import re
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.compat import Record, clone, iso_from_ms, json_stringify, parse_date_ms
from hardwareharness_backend.contracts.errors import to_wire_error
from hardwareharness_backend.wiring import ProjectWiringService

CASES: list[Record] = json.loads(Path(__file__).with_name("wiring-golden.json").read_text("utf-8"))


class GoldenProjects:
    def __init__(self, wiring: Record) -> None:
        self.value = clone(wiring)
        self.dirty = False

    def wiring(self) -> Record:
        return clone(self.value)

    def document(self) -> Record:
        return {"dirty": self.dirty}

    def update_wiring(self, wiring: Record) -> Record:
        self.value = clone(wiring)
        self.dirty = True
        return self.document()


class GoldenCatalog:
    def __init__(self, hardware: list[Record]) -> None:
        self.hardware = hardware

    def get_hardware(self, identifier: str) -> Record:
        for hardware in self.hardware:
            if hardware["hardwareId"] == identifier:
                return clone(hardware)
        raise RuntimeError(f"Unknown hardwareId: {identifier}")

    def resolve_port(self, ref: str) -> Record:
        identifier, port_id = ref.split(".")
        hardware = self.get_hardware(identifier)
        for port in hardware["ports"]:
            if port["portId"] == port_id:
                return {"hardware": hardware, "port": port}
        raise RuntimeError(f"Unknown portRef: {ref}")

    def validate_pins(self, a: str, b: str, pins: list[Record]) -> None:
        for pin in pins:
            for ref, side in ((a, "a"), (b, "b")):
                if not any(
                    value["pinId"] == pin[side] for value in self.resolve_port(ref)["port"]["pins"]
                ):
                    raise RuntimeError(f"Port {ref} has no pin {pin[side]}")

    def warnings_for_ports(self, a: str, b: str) -> list[str]:
        return [f"Missing image: {a}", f"Missing image: {b}"]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
@pytest.mark.asyncio
async def test_original_typescript_wiring_golden(
    case: Record, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = parse_date_ms(case["now"])
    sequence = itertools.count(1)
    module = "hardwareharness_backend.wiring.project_wiring_service"
    monkeypatch.setattr(module + ".new_uuid", lambda: f"uuid-{next(sequence)}")
    monkeypatch.setattr(module + ".now_ms", lambda: clock)
    monkeypatch.setattr(module + ".utc_now_iso", lambda: iso_from_ms(clock))
    projects = GoldenProjects(case["wiring"])
    service = ProjectWiringService(projects, GoldenCatalog(case["hardware"]))
    notifications: list[Record] = []
    project_notifications: list[bool] = []
    service.set_notifier(notifications.append)
    service.set_project_notifier(lambda: project_notifications.append(True))
    results: list[Record] = []
    for action in case["actions"]:
        if action["method"] == "advance":
            clock += action["args"][0]
            results.append({"result": None})
            continue
        method = re.sub(r"([A-Z])", lambda match: "_" + match[1].lower(), action["method"])
        result: Record
        try:
            value: Any = getattr(service, method)(*action["args"])
            if inspect.isawaitable(value):
                value = await value
            result = {"result": value}
        except Exception as error:
            result = {"error": to_wire_error(error)}
        if action.get("inspect"):
            result["wiring"] = projects.wiring()
        results.append(result)
    actual = {
        "results": results,
        "wiring": projects.wiring(),
        "dirty": projects.dirty,
        "notifications": notifications,
        "projectNotifications": len(project_notifications),
    }
    assert actual == case["expected"]
    assert json_stringify(actual, 2) + "\n" == case["expectedJson"]
