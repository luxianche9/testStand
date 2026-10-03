"""A run's journal on disk: ``.teststand/runs/<runId>/run.sqlite`` (design doc §9.5).

One SQLite file (WAL) is the whole evidence of a run:

- ``journal(seq, tb, kind, stepId, opId, body)``: every run event, in order;
- ``results(seq, kind, stepId, body)``: the published results (verdicts, measurements);
- ``snapshots(name, body)``: the plan and wiring as they were at the start, and the
  final run summary (a cache for run history, re-derivable from the journal);
- the stream-recording tables of :mod:`teststand_backend.streams.store`, written
  by the run's recorder through its own connection to the same file.

The interpreter writes through :class:`RunJournal`; the engine reads finished runs back
from it. Nothing here interprets the records.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from teststand_backend.util import clone

Record = dict[str, Any]

RUN_FILE = "run.sqlite"
EMPTY_PLAN: Record = {
    "id": "unknown",
    "name": "历史测试计划",
    "regions": {"prepare": [], "test": [], "cleanup": []},
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS journal(
  seq INTEGER PRIMARY KEY, tb REAL, kind TEXT NOT NULL, stepId TEXT, opId TEXT,
  body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS results(
  seq INTEGER PRIMARY KEY, kind TEXT, stepId TEXT, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(name TEXT PRIMARY KEY, body TEXT NOT NULL);
"""
_READ_TABLES = {"journal": "journal", "results": "results"}


def recording_path(run_dir: Path) -> Path | None:
    """The file holding a run's stream recording, or ``None`` if it recorded nothing."""
    path = run_dir / RUN_FILE
    if path.exists() and "records" in _tables(path):
        return path
    return None


def read_summary(run_dir: Path) -> Record | None:
    """The final summary of a finished run, ``None`` if there is none."""
    value = RunJournal(run_dir).summary()
    return value if isinstance(value, dict) else None


class RunJournal:
    def __init__(self, run_dir: Path, wiring: Callable[[], Any] | None = None) -> None:
        self.run_dir = run_dir
        self.path = run_dir / RUN_FILE
        self._wiring = wiring
        self._db: sqlite3.Connection | None = None

    # -- writing (the interpreter) ----------------------------------------------------------

    def create(self, plan: Record) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=False)
        snapshots: list[tuple[str, Any]] = [("plan", plan)]
        if self._wiring is not None:
            snapshots.append(("wiring", self._wiring()))
        database = self._writer()
        if database is None:
            return
        with database:
            database.executemany(
                "INSERT OR REPLACE INTO snapshots VALUES (?, ?)",
                [(name, _dump(value)) for name, value in snapshots],
            )

    def append_event(self, event: Record) -> None:
        database = self._writer()
        if database is None:
            return
        with database:
            database.execute(
                "INSERT OR REPLACE INTO journal VALUES (?, ?, ?, ?, ?, ?)",
                (
                    int(event.get("sequence", 0)),
                    event.get("tb"),
                    str(event.get("type", "")),
                    _step_id(event),
                    _operation_id(event),
                    _dump(event),
                ),
            )

    def append_result(self, result: Record) -> None:
        database = self._writer()
        if database is None:
            return
        with database:
            database.execute(
                "INSERT OR REPLACE INTO results VALUES (?, ?, ?, ?)",
                (
                    int(result.get("sequence", 0)),
                    result.get("kind"),
                    _step_id(result),
                    _dump(result),
                ),
            )

    def finish(self, summary: Record, events: list[Record]) -> None:
        self._snapshot("summary", summary)
        self.close()

    def reconciled(self, event: Record, summary: Record) -> None:
        """An operation of a finished run was reconciled after the fact."""
        self.append_event(event)
        self._snapshot("summary", summary)
        self.close()

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    def _snapshot(self, name: str, value: Any) -> None:
        database = self._writer()
        if database is None:
            return
        with database:
            database.execute("INSERT OR REPLACE INTO snapshots VALUES (?, ?)", (name, _dump(value)))

    def _writer(self) -> sqlite3.Connection | None:
        """The write connection; ``None`` when the run directory was never created."""
        if self._db is None:
            if not self.run_dir.exists():
                return None
            database = sqlite3.connect(self.path, check_same_thread=False)
            database.execute("PRAGMA journal_mode=WAL")
            database.execute("PRAGMA synchronous=NORMAL")
            database.executescript(_SCHEMA)
            self._db = database
        return self._db

    # -- reading (finished runs) ------------------------------------------------------------

    def events(self, after_sequence: int = 0) -> list[Record]:
        return self._rows("journal", after_sequence)

    def results(self, after_sequence: int = 0) -> list[Record]:
        return self._rows("results", after_sequence)

    def plan(self) -> Record:
        value = self._snapshot_value("plan")
        if value is None:
            return clone(EMPTY_PLAN)
        return (
            clone(value)
            if isinstance(value, dict)
            else {"regions": {"prepare": [], "test": [], "cleanup": []}}
        )

    def wiring(self) -> Any:
        return self._snapshot_value("wiring")

    def summary(self) -> Any:
        return self._snapshot_value("summary")

    def _rows(self, table: str, after_sequence: int) -> list[Record]:
        output: list[Record] = []
        with self._reader() as database:
            if database is None or table not in _table_names(database):
                return output
            query = f"SELECT body FROM {_READ_TABLES[table]} WHERE seq > ? ORDER BY seq"  # noqa: S608
            for (body,) in database.execute(query, (after_sequence,)):
                with contextlib.suppress(json.JSONDecodeError):
                    item = json.loads(body)
                    if isinstance(item, dict):
                        output.append(item)
        return output

    def _snapshot_value(self, name: str) -> Any:
        with self._reader() as database:
            if database is None or "snapshots" not in _table_names(database):
                return None
            row = database.execute("SELECT body FROM snapshots WHERE name = ?", (name,)).fetchone()
        if row is None:
            return None
        with contextlib.suppress(json.JSONDecodeError):
            return json.loads(row[0])
        return None

    @contextlib.contextmanager
    def _reader(self) -> Iterator[sqlite3.Connection | None]:
        if self._db is not None:
            yield self._db
            return
        try:
            database = sqlite3.connect(f"file:{self.path.as_posix()}?mode=ro", uri=True)
        except sqlite3.Error:
            yield None
            return
        try:
            yield database
        finally:
            database.close()


def _step_id(item: Record) -> str | None:
    value = item.get("stepId") or item.get("sourceStepId")
    return str(value) if value else None


def _operation_id(event: Record) -> str | None:
    value = event.get("operationId")
    operation = event.get("operation")
    if not value and isinstance(operation, dict):
        value = operation.get("operationId")
    return str(value) if value else None


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _tables(path: Path) -> set[str]:
    try:
        database = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error:
        return set()
    try:
        return _table_names(database)
    except sqlite3.Error:
        return set()
    finally:
        database.close()


def _table_names(database: sqlite3.Connection) -> set[str]:
    rows = database.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {str(row[0]) for row in rows}
