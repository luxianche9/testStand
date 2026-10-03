from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from teststand_backend.application import OPERATIONS, DefaultAuthorizer
from teststand_backend.application.confirmations import ConfirmationBroker
from teststand_backend.application.registry import OperationRegistry
from teststand_backend.application.services import SystemApplication
from teststand_backend.contracts.errors import AppError

AGENT = {"actor": "agent", "source": "mcp", "subjectId": "client@1"}
HUMAN = {"actor": "human", "source": "desktop"}


def registry(broker: ConfirmationBroker) -> tuple[OperationRegistry, Any]:
    authorizer = DefaultAuthorizer()
    testing = SimpleNamespace(
        authorizer=authorizer,
        reconcile_operation=AsyncMock(return_value={"operationId": "op", "state": "succeeded"}),
    )
    system = SystemApplication(authorizer, Mock(), Mock(), Mock(), broker)
    app = SimpleNamespace(authorizer=authorizer, testing=testing, system=system)
    return OperationRegistry(app, OPERATIONS, confirmer=broker), app


async def pending(broker: ConfirmationBroker) -> list[dict[str, Any]]:
    for _ in range(50):
        if items := broker.pending():
            return items
        await asyncio.sleep(0)
    raise AssertionError("no confirmation was requested")


async def test_operator_approves_the_agents_high_risk_operation() -> None:
    broker = ConfirmationBroker()
    notices: list[list[dict[str, Any]]] = []
    broker.set_notifier(notices.append)
    operations, app = registry(broker)
    call = asyncio.create_task(
        operations.invoke(AGENT, "testing.reconcileOperation", {"input": {"operationId": "op"}})
    )
    [item] = await pending(broker)
    assert item["operation"] == "testing.reconcileOperation"
    assert item["subjectId"] == "client@1"
    assert item["arguments"]["input"]["operationId"] == "op"
    app.testing.reconcile_operation.assert_not_awaited()
    listed = await operations.invoke(HUMAN, "system.listConfirmations")
    assert [entry["confirmationId"] for entry in listed] == [item["confirmationId"]]
    answer = {"confirmationId": item["confirmationId"], "approve": True}
    assert await operations.invoke(HUMAN, "system.answerConfirmation", answer) == {
        "confirmationId": item["confirmationId"],
        "approved": True,
    }
    assert (await call)["state"] == "succeeded"
    app.testing.reconcile_operation.assert_awaited_once()
    assert broker.pending() == []
    assert [len(notice) for notice in notices] == [1, 0]


async def test_declined_or_timed_out_confirmation_denies_the_operation() -> None:
    broker = ConfirmationBroker()
    operations, app = registry(broker)
    call = asyncio.create_task(
        operations.invoke(AGENT, "testing.reconcileOperation", {"input": {"operationId": "op"}})
    )
    [item] = await pending(broker)
    broker.answer(item["confirmationId"], False)
    with pytest.raises(AppError) as declined:
        await call
    assert declined.value.category == "permission_denied"
    assert declined.value.details["confirmationRequired"] is True

    broker.timeout = 0.01
    with pytest.raises(AppError, match="declined"):
        await operations.invoke(
            AGENT, "testing.reconcileOperation", {"input": {"operationId": "op"}}
        )
    app.testing.reconcile_operation.assert_not_awaited()
    assert broker.pending() == []


async def test_only_a_human_answers_and_unknown_answers_fail() -> None:
    broker = ConfirmationBroker()
    operations, _ = registry(broker)
    answer = {"confirmationId": "missing", "approve": True}
    with pytest.raises(AppError) as denied:
        await operations.invoke(AGENT, "system.answerConfirmation", answer)
    assert denied.value.category == "permission_denied"
    with pytest.raises(AppError) as missing:
        await operations.invoke(HUMAN, "system.answerConfirmation", answer)
    assert missing.value.category == "not_found"


async def test_humans_skip_confirmation_and_close_declines_pending() -> None:
    broker = ConfirmationBroker()
    operations, app = registry(broker)
    await operations.invoke(HUMAN, "testing.reconcileOperation", {"input": {"operationId": "op"}})
    assert broker.pending() == []
    app.testing.reconcile_operation.assert_awaited_once()
    call = asyncio.create_task(
        operations.invoke(AGENT, "testing.reconcileOperation", {"input": {"operationId": "op"}})
    )
    await pending(broker)
    broker.close()
    with pytest.raises(AppError, match="declined"):
        await call
