"""Operator confirmation of the Agent's high-risk operations (design doc 8.4).

The operation registry calls the broker for a ``confirm=True`` operation an Agent invoked. The
request waits in the pending list, which the Agent page shows, until the operator approves or
declines it, or until it times out (declined).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.operations import OperationDefinition
from teststand_backend.util import Record, clone, new_uuid, utc_now_iso

CONFIRMATION_TIMEOUT_SECONDS = 300.0


class ConfirmationBroker:
    def __init__(self, timeout: float = CONFIRMATION_TIMEOUT_SECONDS) -> None:
        self.timeout = timeout
        self._pending: dict[str, tuple[Record, asyncio.Future[bool]]] = {}
        self.notifier: Callable[[list[Record]], None] | None = None

    def set_notifier(self, notifier: Callable[[list[Record]], None]) -> None:
        self.notifier = notifier

    def pending(self) -> list[Record]:
        return [clone(record) for record, _ in self._pending.values()]

    async def __call__(
        self, context: Record, definition: OperationDefinition, arguments: Record
    ) -> bool:
        """Wait for the operator's decision on ``definition``; a timeout declines it."""
        confirmation_id = new_uuid()
        record: Record = {
            "confirmationId": confirmation_id,
            "operation": definition.name,
            "summary": definition.summary,
            "risk": definition.spec.risk,
            "arguments": arguments,
            "actor": context.get("actor"),
            "subjectId": context.get("subjectId"),
            "requestedAt": utc_now_iso(),
        }
        future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[confirmation_id] = (record, future)
        self._notify()
        try:
            return await asyncio.wait_for(future, self.timeout)
        except TimeoutError:
            return False
        finally:
            self._pending.pop(confirmation_id, None)
            self._notify()

    def answer(self, confirmation_id: str, approve: bool) -> Record:
        entry = self._pending.get(confirmation_id)
        if entry is None:
            raise app_error(
                "not_found",
                f"No pending confirmation {confirmation_id}",
                {"confirmationId": confirmation_id},
            )
        if not entry[1].done():
            entry[1].set_result(approve)
        return {"confirmationId": confirmation_id, "approved": approve}

    def close(self) -> None:
        """Decline everything still waiting (the service is shutting down)."""
        for _, future in list(self._pending.values()):
            if not future.done():
                future.set_result(False)

    def _notify(self) -> None:
        if self.notifier is not None:
            self.notifier(self.pending())
