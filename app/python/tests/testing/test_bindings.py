from __future__ import annotations

from pathlib import Path
from typing import Any

from teststand_backend.testing.bindings import expand_bindings
from teststand_backend.testing.compiler import compile_plan
from teststand_backend.testing.validation import validate_plan

from .test_batch import make_app, run_batch
from .test_testing import HUMAN, Resolver, plan_with

REVISION = Resolver().resolve("any", "read")[0]["bindingRevision"]
READ = {
    "id": "read",
    "type": "InvokeTool",
    "hardwareId": "psu",
    "toolName": "read",
    "arguments": {},
    "bindingRevision": REVISION,
}
WATCH = {"id": "watch", "type": "Observe", "hardwareId": "uart", "durationMs": 10}


def station_plan(*steps: dict[str, Any]) -> dict[str, Any]:
    plan = plan_with(*steps)
    plan["parameters"] = [{"name": "station", "type": "integer", "default": 1}]
    plan["bindings"] = {
        "psu": {"hardwareId": "PC1.PSU_${station}"},
        "uart": {"hardwareId": "PC1.CARD", "streamId": "serial${station}"},
    }
    return plan


def test_bindings_expand_from_station_values_or_parameter_defaults() -> None:
    plan = station_plan(READ, WATCH)
    expanded, issues = expand_bindings(plan, {"station": 3})
    assert not issues
    read, watch = expanded["regions"]["test"]
    assert read["hardwareId"] == "PC1.PSU_3"
    assert "streamId" not in read
    assert (watch["hardwareId"], watch["streamId"]) == ("PC1.CARD", "serial3")
    assert expand_bindings(plan)[0]["regions"]["test"][0]["hardwareId"] == "PC1.PSU_1"
    # The source plan keeps its logical names.
    assert plan["regions"]["test"][0]["hardwareId"] == "psu"


def test_binding_issues() -> None:
    plan = station_plan(READ)
    plan["parameters"] = []
    plan["bindings"]["bad name"] = {"hardwareId": "x"}
    plan["bindings"]["empty"] = {"hardwareId": "", "port": 1}
    issues = {(item["code"], item["path"]) for item in validate_plan(plan)}
    assert ("binding.variable", "/bindings/psu/hardwareId") in issues
    assert ("binding.name", "/bindings/bad name") in issues
    assert ("binding.invalid", "/bindings/empty") in issues
    assert ("binding.invalid", "/bindings/empty/hardwareId") in issues


def test_compile_resolves_the_station_hardware_and_keeps_one_execution_revision() -> None:
    plan = station_plan(READ)
    first = compile_plan(plan, Resolver(), values={"station": 1})
    second = compile_plan(plan, Resolver(), values={"station": 2})
    assert first["valid"] and second["valid"]
    assert first["compiledPlan"]["resolvedBindings"]["read"]["deviceId"] == "PC1.PSU_1"
    assert second["compiledPlan"]["resolvedBindings"]["read"]["deviceId"] == "PC1.PSU_2"
    assert first["executionRevision"] == second["executionRevision"]


async def test_batch_runs_each_item_once_per_station(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    plan = station_plan(READ)
    await app.create_plan(
        HUMAN,
        {
            "requestId": "create-power",
            "id": "power",
            "name": "Power",
            "parameters": plan["parameters"],
            "bindings": plan["bindings"],
            "regions": plan["regions"],
        },
    )
    stations = [{"station": number} for number in (1, 2, 3)]
    batch = await run_batch(app, "batch-stations", "power", stations=stations)
    assert batch["state"] == "completed"
    assert [item["station"] for item in batch["items"]] == stations
    hardware = [app.engine.get(item["runId"])["hardwareIds"] for item in batch["items"]]
    assert hardware == [["PC1.PSU_1"], ["PC1.PSU_2"], ["PC1.PSU_3"]]
