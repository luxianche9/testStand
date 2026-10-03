"""Protocol bindings end to end (§6.4/§6.5): ICD-derived streams judged, re-judged and encoded."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from teststand_backend.application import ExecutionCoordinator
from teststand_backend.protocol import Icd, checksums, encode, icd_hash, load_icd
from teststand_backend.testing import TestEngine
from teststand_backend.testing.compiler import compile_plan
from teststand_backend.testing.validation import validate_plan

from .fake_service import FakeStreamService
from .test_engine_steps import STREAMS, Projects, Resolver, StreamDevices, finish, plan_with

DUT_CMD_YAML = """\
formatVersion: 1
name: dut_cmd
transport: bytes
framing:
  kind: header_length
  header: "AA 55"
  lengthField: {offset: 2, size: 1}
  lengthCovers: payload
  trailer: checksum
checksum: {algorithm: crc16_modbus, range: {from: 2, to: -2}, offset: -2, endian: little}
messages:
  - name: status
    match: {offset: 3, value: 0x81}
    fields:
      - {name: selfTest, offset: 4, type: u8, bits: "0", enum: {0: fail, 1: pass}}
      - {name: voltage,  offset: 5, type: i16, endian: little, scale: 0.01, unit: V}
  - name: ack
    match: {offset: 3, value: 0x01}
    fields:
      - {name: code, offset: 4, type: u8}
encoders:
  - name: set_mode
    template: {header: "AA 55", cmd: 0x10}
    fields: [{name: mode, offset: 4, type: u8}]
"""


def dut_cmd() -> Icd:
    return load_icd(DUT_CMD_YAML)


def _framed(payload: bytes) -> bytes:
    body = b"\xaa\x55" + bytes([len(payload)]) + payload
    return body + checksums.compute("crc16_modbus", body[2:]).to_bytes(2, "little")


def status_frame(voltage: int) -> bytes:
    return _framed(b"\x81\x01" + voltage.to_bytes(2, "little", signed=True))


def ack_frame(code: int) -> bytes:
    return _framed(bytes([0x01, code]))


BINDING = {"icd": "dut_cmd", "alias": "dut", "source": {"hardwareId": "dev", "streamId": "rx"}}


class IcdResolver(Resolver):
    """The test resolver plus the project's ICD library and a ``write(data)`` tool."""

    def __init__(self, icds: dict[str, Icd] | None = None) -> None:
        self.icds = {"dut_cmd": dut_cmd()} if icds is None else icds

    def icd(self, name: str) -> Icd | None:
        return self.icds.get(name)

    def streams(self, hardware_id: str) -> dict[str, str]:
        return dict(STREAMS)

    def resolve(self, hardware_id: str, tool_name: str) -> tuple[dict[str, Any], list[Any]]:
        tool, issues = super().resolve(hardware_id, tool_name)
        tool["inputSchema"] = {"type": "object", "properties": {"data": {"type": "string"}}}
        return tool, issues


class DutDevices(StreamDevices):
    """``write`` answers every command with a status frame split over two rx records."""

    def __init__(self, service: FakeStreamService) -> None:
        super().__init__(service)
        self.written: list[dict[str, Any]] = []

    async def _status(self) -> None:
        await asyncio.sleep(0.05)
        frame = status_frame(voltage=1234)
        self.service.publish("rx", dir="rx", data=frame[:5].hex())
        self.service.publish("rx", dir="rx", data=frame[5:].hex())

    async def call_aggregated_tool(
        self, name: str, arguments: dict[str, Any], options: dict[str, Any] | None = None
    ) -> Any:
        if name.endswith("__write"):
            self.written.append(dict(arguments))
            task = asyncio.create_task(self._status())
            self.replies.add(task)
        return await super().call_aggregated_tool(name, arguments, options)


def protocol_plan(*steps: dict[str, Any]) -> dict[str, Any]:
    plan = plan_with(*steps)
    plan["protocolBindings"] = [BINDING]
    return plan


def write_step(**encode_spec: Any) -> dict[str, Any]:
    return {
        "id": "command",
        "type": "InvokeTool",
        "hardwareId": "dev",
        "toolName": "write",
        "arguments": {},
        "anchor": "sent",
        "encode": {"icd": "dut_cmd", "message": "set_mode", "fields": {"mode": 3}, **encode_spec},
    }


def expect(step_id: str, stream_id: str, match: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": step_id,
        "type": "Expect",
        "hardwareId": "dev",
        "streamId": stream_id,
        "anchor": "sent",
        "withinMs": 1000,
        "match": match,
    }


def codes(issues: list[dict[str, Any]]) -> set[str]:
    """Error codes, minus ``invoke.binding``: the test tools carry no binding revision."""
    return {
        item["code"]
        for item in issues
        if item["severity"] == "error" and item["code"] != "invoke.binding"
    }


def test_validation_resolves_bindings_and_encoders() -> None:
    plan = protocol_plan(
        write_step(), expect("status", "dut.status", {"fields": {"selfTest": "pass"}})
    )
    assert codes(validate_plan(plan, IcdResolver())) == set()

    assert "protocol.icd_missing" in codes(validate_plan(plan, IcdResolver({})))
    wrong = protocol_plan(expect("volts", "dut.status.nope", {"op": "gt", "value": 1}))
    assert "stream.missing" in codes(validate_plan(wrong, IcdResolver()))
    ai = protocol_plan()
    ai["protocolBindings"] = [{**BINDING, "source": {"hardwareId": "dev", "streamId": "ai0"}}]
    assert "protocol.source" in codes(validate_plan(ai, IcdResolver()))
    twice = protocol_plan()
    twice["protocolBindings"] = [BINDING, BINDING]
    assert "protocol.alias" in codes(validate_plan(twice, IcdResolver()))
    bad_field = protocol_plan(write_step(fields={"speed": 1}))
    assert "invoke.encode" in codes(validate_plan(bad_field, IcdResolver()))
    bad_encoder = protocol_plan(write_step(message="reboot"))
    assert "invoke.encode" in codes(validate_plan(bad_encoder, IcdResolver()))


def test_compiled_plan_freezes_the_icds() -> None:
    plan = protocol_plan(write_step())
    result = compile_plan(plan, IcdResolver())
    assert codes(result["issues"]) == set()
    compiled = result["compiledPlan"]
    assert compiled["icds"]["dut_cmd"]["icdHash"] == icd_hash(dut_cmd())
    assert compiled["icds"]["dut_cmd"]["document"]["name"] == "dut_cmd"


async def test_derived_streams_are_judged_as_protocol_evidence_and_rejudged(
    tmp_path: Path,
) -> None:
    plan = protocol_plan(
        {
            "id": "quiet",
            "type": "Guard",
            "hardwareId": "dev",
            "streamId": "dut.ack",
            "condition": {},
            "onViolation": "fail",
            "children": [
                write_step(),
                expect("status", "dut.status", {"fields": {"selfTest": "pass", "voltage": 12.34}}),
                expect("volts", "dut.status.voltage", {"op": "gt", "value": 12}),
            ],
        },
    )
    async with FakeStreamService(STREAMS, sampled=frozenset({"ai0"})) as service:
        sources = service.sources()
        devices = DutDevices(service)
        async with devices:
            engine = TestEngine(
                Projects(tmp_path),
                devices,
                IcdResolver(),
                ExecutionCoordinator(),
                stream_sources=sources,
            )
            compiled = compile_plan(plan, IcdResolver())["compiledPlan"]
            completed = await finish(engine, await engine.start(compiled, {}))

    run = engine.runs[completed["runId"]]
    outcome = [(item["name"], item.get("verdict"), item.get("evidence")) for item in run.results]
    assert completed["verdict"] == "Pass", outcome
    assert devices.written == [{"data": encode(dut_cmd(), "set_mode", {"mode": 3}).wire.hex()}]
    verdicts = {item["sourceStepId"]: item for item in run.results if item.get("kind") == "verdict"}
    assert set(verdicts) == {"quiet", "status", "volts"}
    for item in verdicts.values():
        assert item["verdict"] == "Pass"
        assert item["judge"]["protocol"] == {
            "alias": "dut",
            "icd": "dut_cmd",
            "icdHash": icd_hash(dut_cmd()),
            "source": "dev__rx",
        }
    rejudged = engine.rejudge_run(completed["runId"])
    assert rejudged["consistent"] is True
    assert {item["result"]["evidenceType"] for item in rejudged["results"]} == {"P"}

    # The run monitor (U4): decoded message table and the derived numeric fields as streams.
    table = engine.read_run_messages(completed["runId"], {})
    [binding] = table["bindings"]
    assert binding["recorded"] is True and binding["messages"] == ["status", "ack"]
    [status] = [row for row in table["messages"] if row["kind"] == "message"]
    assert status["streamId"] == "dut.status" and status["raw"] == status_frame(1234).hex()
    assert status["fields"] == {"selfTest": "pass", "voltage": 12.34}
    assert status["tb"] is not None and table["truncated"] is False
    timeline = engine.get_run_timeline(completed["runId"])
    derived = {item["key"]: item for item in timeline["streams"] if item.get("derived")}
    assert set(derived) == {
        "dev__dut.status.selfTest",
        "dev__dut.status.voltage",
        "dev__dut.ack.code",
    }
    voltage = derived["dev__dut.status.voltage"]
    assert voltage["count"] == 1 and voltage["derived"]["unit"] == "V"
    tb = float(status["tb"])
    window = engine.stream_window(completed["runId"], [voltage["key"]], tb - 10, tb + 10, 100)
    assert [point["v"] for point in window["streams"][voltage["key"]]["points"]] == [12.34]
    io = engine.read_run_io(completed["runId"])
    [summary] = [item for item in io["streams"] if item["key"] == voltage["key"]]
    assert summary["summary"]["count"] == 1


async def test_guard_on_a_derived_stream_fails_on_the_forbidden_message(tmp_path: Path) -> None:
    class AckingDevices(DutDevices):
        async def _status(self) -> None:
            await asyncio.sleep(0.05)
            self.service.publish("rx", dir="rx", data=ack_frame(7).hex())

    plan = protocol_plan(
        {
            "id": "quiet",
            "type": "Guard",
            "hardwareId": "dev",
            "streamId": "dut.ack",
            "condition": {"fields": {"code": 7}},
            "onViolation": "fail",
            "children": [write_step(), {"id": "hold", "type": "Delay", "durationMs": 500}],
        },
    )
    async with FakeStreamService(STREAMS, sampled=frozenset({"ai0"})) as service:
        sources = service.sources()
        async with AckingDevices(service) as devices:
            engine = TestEngine(
                Projects(tmp_path),
                devices,
                IcdResolver(),
                ExecutionCoordinator(),
                stream_sources=sources,
            )
            compiled = compile_plan(plan, IcdResolver())["compiledPlan"]
            completed = await finish(engine, await engine.start(compiled, {}))
    assert completed["verdict"] == "Fail", engine.runs[completed["runId"]].results
    assert engine.rejudge_run(completed["runId"])["consistent"] is True
