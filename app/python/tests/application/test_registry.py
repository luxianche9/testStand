"""The registry middleware, in the order of design doc §9.3."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from teststand_backend.application.authorization import (
    AGENT_REQUEST_CONTEXT,
    HUMAN_REQUEST_CONTEXT,
    DefaultAuthorizer,
)
from teststand_backend.application.registry import OperationRegistry
from teststand_backend.contracts.errors import AppError
from teststand_backend.contracts.operations import (
    OperationDefinition,
    collect_operations,
    operation,
)
from teststand_backend.util import Record


class Bench:
    authorizer = DefaultAuthorizer()

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.failure: Exception | None = None
        self.gate: asyncio.Event | None = None

    @operation("bench.read", capability="devices.read", risk="read")
    async def read(self, context: Record, channel: int) -> Record:
        self.calls.append(("read", channel))
        return {"channel": channel}

    @operation("bench.drive", capability="hardware.executeTools", risk="actuate", confirm=True)
    async def drive(self, context: Record, voltage: float, api_key: str | None = None) -> Record:
        self.calls.append(("drive", voltage))
        if self.failure is not None:
            raise self.failure
        return {"voltage": voltage}

    @operation(
        "bench.start",
        capability="testing.execute",
        risk="write",
        idempotency="request-id",
    )
    async def start(self, context: Record, request_id: str, plan: str) -> Record:
        self.calls.append(("start", plan))
        if self.gate is not None:
            await self.gate.wait()
        if self.failure is not None:
            raise self.failure
        return {"run": len(self.calls)}

    @operation("bench.forget", capability="system.manage", risk="destructive")
    def forget(self, context: Record) -> None:
        self.calls.append(("forget", None))


DEFINITIONS: dict[str, OperationDefinition] = collect_operations({"bench": Bench})


class Audit:
    def __init__(self) -> None:
        self.records: list[Record] = []

    def append(self, record: Record) -> None:
        self.records.append(record)


def registry(confirmer: Any = None) -> tuple[Bench, Audit, OperationRegistry]:
    bench = Bench()
    audit = Audit()
    targets = SimpleNamespace(authorizer=bench.authorizer, bench=bench)
    return bench, audit, OperationRegistry(targets, DEFINITIONS, audit=audit, confirmer=confirmer)


HUMAN = dict(HUMAN_REQUEST_CONTEXT)
AGENT = dict(AGENT_REQUEST_CONTEXT)


async def test_validation_runs_before_anything_else() -> None:
    bench, audit, operations = registry()
    with pytest.raises(AppError) as error:
        await operations.invoke(HUMAN, "bench.read", {"channel": "not a number"})
    assert error.value.category == "invalid_argument"
    assert error.value.details["issues"][0]["loc"] == ("channel",)
    with pytest.raises(AppError, match="Invalid request"):
        await operations.invoke(HUMAN, "bench.read", b'{"channel": 1, "extra": 2}')
    with pytest.raises(AppError, match="Invalid request"):
        await operations.invoke(HUMAN, "bench.read", None)  # channel is required
    assert bench.calls == []
    assert [record["outcome"] for record in audit.records] == ["error"] * 3


async def test_capability_is_checked_before_confirmation() -> None:
    asked: list[str] = []

    async def confirm(context: Record, definition: OperationDefinition, arguments: Record) -> bool:
        asked.append(definition.name)
        return True

    bench, _, operations = registry(confirm)
    with pytest.raises(AppError) as denied:
        await operations.invoke(AGENT, "bench.forget", {})
    assert denied.value.category == "permission_denied"
    assert asked == [] and bench.calls == []


async def test_agent_actuation_needs_the_operators_confirmation() -> None:
    decisions = [False, True]
    seen: list[Record] = []

    async def confirm(context: Record, definition: OperationDefinition, arguments: Record) -> bool:
        seen.append(arguments)
        return decisions.pop(0)

    bench, _, operations = registry(confirm)
    body = {"voltage": 1.5, "apiKey": "hidden"}
    with pytest.raises(AppError, match="declined") as declined:
        await operations.invoke(AGENT, "bench.drive", body)
    assert declined.value.details["confirmationRequired"] is True
    assert bench.calls == []
    assert await operations.invoke(AGENT, "bench.drive", body) == {"voltage": 1.5}
    assert seen[0]["api_key"] == "[REDACTED]"
    # A human at the desktop is the operator: no second confirmation.
    assert await operations.invoke(HUMAN, "bench.drive", {"voltage": 2}) == {"voltage": 2}
    assert len(seen) == 2


async def test_without_a_confirmer_agent_confirmation_is_denied() -> None:
    bench, _, operations = registry()
    with pytest.raises(AppError, match="needs the operator") as error:
        await operations.invoke(AGENT, "bench.drive", {"voltage": 1})
    assert error.value.category == "permission_denied"
    assert bench.calls == []


async def test_request_id_replays_the_result_and_rejects_different_arguments() -> None:
    bench, _, operations = registry()
    first = await operations.invoke(HUMAN, "bench.start", {"requestId": "r1", "plan": "a"})
    again = await operations.invoke(HUMAN, "bench.start", {"requestId": "r1", "plan": "a"})
    assert first == again
    assert bench.calls == [("start", "a")]
    with pytest.raises(AppError) as conflict:
        await operations.invoke(HUMAN, "bench.start", {"requestId": "r1", "plan": "b"})
    assert conflict.value.category == "conflict"
    await operations.invoke(HUMAN, "bench.start", {"requestId": "r2", "plan": "a"})
    assert len(bench.calls) == 2


async def test_concurrent_duplicates_share_one_execution() -> None:
    bench, _, operations = registry()
    bench.gate = asyncio.Event()
    body = {"requestId": "same", "plan": "p"}
    calls = [asyncio.create_task(operations.invoke(HUMAN, "bench.start", body)) for _ in range(3)]
    await asyncio.sleep(0)
    bench.gate.set()
    results = await asyncio.gather(*calls)
    assert results[0] == results[1] == results[2]
    assert bench.calls == [("start", "p")]


async def test_a_failed_attempt_is_not_recorded_and_may_be_retried() -> None:
    bench, _, operations = registry()
    bench.failure = AppError("unavailable", "busy")
    body = {"requestId": "retry", "plan": "p"}
    with pytest.raises(AppError, match="busy"):
        await operations.invoke(HUMAN, "bench.start", body)
    bench.failure = None
    assert await operations.invoke(HUMAN, "bench.start", body) == {"run": 2}


async def test_audit_skips_successful_reads_and_redacts_secrets() -> None:
    _, audit, operations = registry()
    await operations.invoke(HUMAN, "bench.read", {"channel": 1})
    assert audit.records == []
    await operations.invoke(HUMAN, "bench.drive", {"voltage": 3, "apiKey": "hidden"})
    await operations.invoke(HUMAN, "bench.forget", {})
    drive, forget = audit.records
    assert drive["operation"] == "bench.drive" and drive["risk"] == "actuate"
    assert drive["arguments"] == {"voltage": 3.0, "api_key": "[REDACTED]"}
    assert drive["actor"] == "human" and drive["outcome"] == "ok"
    assert forget["risk"] == "destructive"
    assert "hidden" not in repr(audit.records)


@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("no reply"),
        ConnectionResetError("link lost"),
        AppError("unavailable", "dropped", {"outcomeKnown": False}),
    ],
)
async def test_actuation_with_an_unknown_outcome_is_never_retried(failure: Exception) -> None:
    bench, audit, operations = registry()
    bench.failure = failure
    with pytest.raises(AppError) as error:
        await operations.invoke(HUMAN, "bench.drive", {"voltage": 5})
    assert error.value.category == "unknown_outcome"
    assert error.value.details["automaticRetry"] is False
    assert error.value.details["operation"] == "bench.drive"
    assert audit.records[-1]["error"]["category"] == "unknown_outcome"


async def test_a_known_failure_keeps_its_category() -> None:
    bench, _, operations = registry()
    bench.failure = AppError("validation_failed", "out of range")
    with pytest.raises(AppError) as error:
        await operations.invoke(HUMAN, "bench.drive", {"voltage": 99})
    assert error.value.category == "validation_failed"


async def test_unknown_operations_are_not_found() -> None:
    _, audit, operations = registry()
    with pytest.raises(AppError) as error:
        await operations.invoke(HUMAN, "bench.__init__", {})
    assert error.value.category == "not_found"
    assert audit.records[0]["risk"] is None
