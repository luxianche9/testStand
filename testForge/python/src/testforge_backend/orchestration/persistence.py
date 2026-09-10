from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field

from testforge_backend.compat import clone

from .ports import Json, RunLogPort


@dataclass
class PendingRun:
    run: Json | None = None
    nodes: dict[str, Json] = field(default_factory=dict)
    events: list[Json] = field(default_factory=list)
    snapshot: Json | None = None


class RunPersistence:
    def __init__(
        self, logs: RunLogPort, session: Callable[[], Json | None], warning: Callable[[str], None]
    ) -> None:
        self.logs, self.session, self.warning = logs, session, warning
        self.pending: dict[str, PendingRun] = {}
        self.worker: asyncio.Task[None] | None = None
        self.retry_attempt = 0

    def enqueue(self, mutation: Json) -> None:
        kind = mutation["type"]
        run_id = (
            mutation["run"]["runId"]
            if kind == "run"
            else mutation["nodeRun"]["runId"]
            if kind == "nodeRun"
            else mutation["runId"]
        )
        pending = self.pending.setdefault(run_id, PendingRun())
        if kind == "run":
            pending.run = clone(mutation["run"])
        elif kind == "nodeRun":
            pending.nodes[mutation["nodeRun"]["nodeRunId"]] = clone(mutation["nodeRun"])
        else:
            pending.events.extend(clone(mutation["events"]))
        self._start()

    def enqueue_snapshot(self, snapshot: Json) -> None:
        self.pending.setdefault(snapshot["runId"], PendingRun()).snapshot = clone(snapshot)
        self._start()

    def _start(self) -> None:
        if self.worker is None and self.pending:
            self.worker = asyncio.create_task(self._persist())

    async def _persist(self) -> None:
        try:
            while self.pending:
                run_id = next(iter(self.pending))
                batch = self.pending.pop(run_id)
                session = self.session()
                if session is None:
                    continue
                try:
                    root = session["rootPath"]
                    if batch.run is not None:
                        await self.logs.upsert_run(root, batch.run)
                    for node in batch.nodes.values():
                        await self.logs.upsert_node_run(root, node)
                    if batch.events:
                        await self.logs.append_events(root, run_id, batch.events)
                    if batch.snapshot is not None:
                        await self.logs.upsert_execution_snapshot(root, batch.snapshot)
                    self.retry_attempt = 0
                except Exception as error:
                    current = self.pending.get(run_id)
                    if current:
                        batch = PendingRun(
                            current.run or batch.run,
                            {**batch.nodes, **current.nodes},
                            [*batch.events, *current.events],
                            current.snapshot or batch.snapshot,
                        )
                    self.pending[run_id] = batch
                    self.retry_attempt += 1
                    milliseconds = min(2000, 25 * 2 ** min(self.retry_attempt - 1, 6))
                    self.warning(
                        f"{run_id}: failed to persist Run log; "
                        f"retrying in {milliseconds} ms: {error}"
                    )
                    await asyncio.sleep(milliseconds / 1000)
        finally:
            self.worker = None
            self._start()

    async def flush(self) -> None:
        self._start()
        while self.worker is not None:
            await self.worker

    async def remove(self, root: str, run_id: str) -> None:
        await self.flush()
        await self.logs.remove(root, run_id)
        self.pending.pop(run_id, None)

    async def clear_runs(self, root: str, run_ids: list[str]) -> None:
        await self.flush()
        await self.logs.clear(root, run_ids)
        for run_id in run_ids:
            self.pending.pop(run_id, None)

    def clear(self) -> None:
        self.pending.clear()
        self.worker = None
        self.retry_attempt = 0
