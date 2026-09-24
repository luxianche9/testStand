from __future__ import annotations

import base64
import binascii
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, cast

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import clone, utc_now_iso

Record = dict[str, Any]


def payload_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class RuntimeStateStore:
    """Project-local durable state for requests, physical operations and runs."""

    def __init__(self, projects: Any) -> None:
        self.projects = projects
        self._initialized_path: Path | None = None

    def path(self) -> Path:
        session = self.projects.session()
        if not session:
            raise app_error("requires_project", "requires_project")
        return Path(session["rootPath"]) / ".hardwareharness" / "runtime.sqlite3"

    def initialize(self) -> None:
        current = self.path()
        if self._initialized_path == current:
            return
        with self._connect() as database:
            database.executescript(
                """
                CREATE TABLE IF NOT EXISTS requests (
                    scope TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
                    state TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, PRIMARY KEY(scope, request_id)
                );
                CREATE TABLE IF NOT EXISTS operations (
                    operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, hardware_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL,
                    outcome_known INTEGER NOT NULL, recovery_required INTEGER NOT NULL,
                    result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS operations_run_idx ON operations(run_id);
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
                    execution_revision TEXT, state TEXT NOT NULL, snapshot_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS wiring_tasks (
                    wiring_task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                    task_json TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batches (
                    batch_id TEXT PRIMARY KEY, state TEXT NOT NULL, batch_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            operation_columns = {
                str(row[1]) for row in database.execute("PRAGMA table_info(operations)").fetchall()
            }
            if "resolved_by_operation_id" not in operation_columns:
                database.execute("ALTER TABLE operations ADD COLUMN resolved_by_operation_id TEXT")
            if "resolved_at" not in operation_columns:
                database.execute("ALTER TABLE operations ADD COLUMN resolved_at TEXT")
            if "step_id" not in operation_columns:
                database.execute("ALTER TABLE operations ADD COLUMN step_id TEXT")
            if "execution_id" not in operation_columns:
                database.execute("ALTER TABLE operations ADD COLUMN execution_id TEXT")
            self._recover_interrupted(database)
            self._import_legacy_requests(database)
        self._initialized_path = current

    def claim_request(self, scope: str, request_id: str, payload: Any) -> Record | None:
        digest = payload_hash(payload)
        now = utc_now_iso()
        with self._connect() as database:
            row = database.execute(
                "SELECT payload_hash,state,result_json FROM requests "
                "WHERE scope=? AND request_id=?",
                (scope, request_id),
            ).fetchone()
            if row:
                if row[0] not in {digest, "legacy-unknown"}:
                    raise app_error(
                        "conflict",
                        "requestId was already used with different input",
                        {"scope": scope, "requestId": request_id},
                    )
                return {
                    "state": row[1],
                    **({"result": json.loads(row[2])} if row[2] else {}),
                }
            database.execute(
                "INSERT INTO requests VALUES (?,?,?,?,?,?,?)",
                (scope, request_id, digest, "pending", None, now, now),
            )
        return None

    def complete_request(self, scope: str, request_id: str, result: Record) -> None:
        with self._connect() as database:
            database.execute(
                "UPDATE requests SET state='completed',result_json=?,updated_at=? "
                "WHERE scope=? AND request_id=?",
                (json.dumps(result, ensure_ascii=False), utc_now_iso(), scope, request_id),
            )

    def release_request(self, scope: str, request_id: str) -> None:
        with self._connect() as database:
            database.execute(
                "DELETE FROM requests WHERE scope=? AND request_id=? AND state='pending'",
                (scope, request_id),
            )

    def record_operation(self, operation: Record) -> None:
        now = utc_now_iso()
        with self._connect() as database:
            database.execute(
                "INSERT INTO operations "
                "(operation_id,run_id,hardware_id,tool_name,input_hash,state,"
                "outcome_known,recovery_required,result_json,created_at,updated_at,"
                "step_id,execution_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    operation["operationId"],
                    operation["runId"],
                    operation["hardwareId"],
                    operation["toolName"],
                    operation["inputHash"],
                    operation["state"],
                    int(operation.get("outcomeKnown", True)),
                    int(operation.get("recoveryRequired", False)),
                    json.dumps(operation.get("result"), ensure_ascii=False)
                    if "result" in operation
                    else None,
                    now,
                    now,
                    operation.get("stepId"),
                    operation.get("executionId"),
                ),
            )

    def update_operation(self, operation_id: str, **changes: Any) -> None:
        allowed = {
            "state",
            "outcomeKnown",
            "recoveryRequired",
            "result",
            "resolvedByOperationId",
            "resolvedAt",
        }
        values = {key: value for key, value in changes.items() if key in allowed}
        if not values:
            return
        assignments: list[str] = []
        parameters: list[Any] = []
        for key, value in values.items():
            column = {
                "outcomeKnown": "outcome_known",
                "recoveryRequired": "recovery_required",
                "result": "result_json",
                "resolvedByOperationId": "resolved_by_operation_id",
                "resolvedAt": "resolved_at",
            }.get(key, key)
            assignments.append(f"{column}=?")
            if key in {"outcomeKnown", "recoveryRequired"}:
                parameters.append(int(bool(value)))
            elif key == "result":
                parameters.append(json.dumps(value, ensure_ascii=False))
            else:
                parameters.append(value)
        parameters.extend([utc_now_iso(), operation_id])
        with self._connect() as database:
            database.execute(
                f"UPDATE operations SET {','.join(assignments)},updated_at=? WHERE operation_id=?",
                parameters,
            )

    def operations(self, run_id: str | None = None, recovery_only: bool = False) -> list[Record]:
        query = (
            "SELECT operation_id,run_id,hardware_id,tool_name,state,outcome_known,"
            "recovery_required,result_json,resolved_by_operation_id,resolved_at,"
            "step_id,execution_id FROM operations"
        )
        clauses, parameters = [], []
        if run_id:
            clauses.append("run_id=?")
            parameters.append(run_id)
        if recovery_only:
            clauses.append("recovery_required=1")
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at"
        with self._connect() as database:
            rows = database.execute(query, parameters).fetchall()
        return [
            {
                "operationId": row[0],
                "runId": row[1],
                "hardwareId": row[2],
                "toolName": row[3],
                "state": row[4],
                "outcomeKnown": bool(row[5]),
                "recoveryRequired": bool(row[6]),
                **({"result": json.loads(row[7])} if row[7] else {}),
                **({"resolvedByOperationId": row[8]} if row[8] else {}),
                **({"resolvedAt": row[9]} if row[9] else {}),
                **({"stepId": row[10]} if row[10] else {}),
                **({"executionId": row[11]} if row[11] else {}),
            }
            for row in rows
        ]

    def save_run(self, snapshot: Record) -> None:
        with self._connect() as database:
            database.execute(
                "INSERT INTO runs VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET "
                "state=excluded.state,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",
                (
                    snapshot["runId"],
                    snapshot["planId"],
                    snapshot["revision"],
                    snapshot.get("executionRevision"),
                    snapshot["state"],
                    json.dumps(snapshot, ensure_ascii=False),
                    utc_now_iso(),
                ),
            )

    def load_run(self, run_id: str) -> Record | None:
        with self._connect() as database:
            row = database.execute(
                "SELECT snapshot_json FROM runs WHERE run_id=?", (run_id,)
            ).fetchone()
        return self.normalize_run(clone(json.loads(row[0]))) if row else None

    def latest_run(self) -> Record | None:
        with self._connect() as database:
            row = database.execute(
                "SELECT snapshot_json FROM runs ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        return self.normalize_run(clone(json.loads(row[0]))) if row else None

    def list_runs(
        self,
        *,
        cursor: str | None = None,
        limit: int = 50,
        plan_id: str | None = None,
        verdict: str | None = None,
        state: str | None = None,
        from_at: str | None = None,
        to_at: str | None = None,
    ) -> Record:
        self.initialize()
        self._index_run_artifacts()
        bounded_limit = min(max(int(limit), 1), 200)
        cursor_key = self._decode_cursor(cursor) if cursor else None
        with self._connect() as database:
            rows = database.execute("SELECT snapshot_json FROM runs").fetchall()
        snapshots = [self.normalize_run(json.loads(row[0])) for row in rows]
        items = [
            item
            for item in snapshots
            if (not plan_id or item.get("planId") == plan_id)
            and (not verdict or item.get("verdict") == verdict)
            and (not state or item.get("state") == state)
            and (not from_at or str(item.get("startedAt", "")) >= from_at)
            and (not to_at or str(item.get("startedAt", "")) <= to_at)
        ]
        items.sort(
            key=lambda item: (str(item.get("startedAt", "")), str(item.get("runId", ""))),
            reverse=True,
        )
        if cursor_key:
            items = [
                item
                for item in items
                if (str(item.get("startedAt", "")), str(item.get("runId", ""))) < cursor_key
            ]
        page = items[: bounded_limit + 1]
        has_more = len(page) > bounded_limit
        page = page[:bounded_limit]
        summaries = [self._run_summary(item) for item in page]
        next_cursor = None
        if has_more and page:
            last = page[-1]
            next_cursor = self._encode_cursor(
                str(last.get("startedAt", "")), str(last.get("runId", ""))
            )
        return {"items": summaries, **({"nextCursor": next_cursor} if next_cursor else {})}

    def run_snapshots(self) -> list[Record]:
        self.initialize()
        self._index_run_artifacts()
        with self._connect() as database:
            rows = database.execute("SELECT snapshot_json FROM runs").fetchall()
        return [self.normalize_run(json.loads(row[0])) for row in rows]

    def get_metadata(self, key: str) -> Any:
        self.initialize()
        with self._connect() as database:
            row = database.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def set_metadata(self, key: str, value: Any) -> None:
        self.initialize()
        with self._connect() as database:
            database.execute(
                "INSERT OR REPLACE INTO metadata VALUES (?,?)",
                (key, json.dumps(value, ensure_ascii=False)),
            )

    def save_batch(self, batch: Record) -> None:
        self.initialize()
        with self._connect() as database:
            database.execute(
                "INSERT INTO batches VALUES (?,?,?,?) ON CONFLICT(batch_id) DO UPDATE SET "
                "state=excluded.state,batch_json=excluded.batch_json,updated_at=excluded.updated_at",
                (
                    batch["batchId"],
                    batch["state"],
                    json.dumps(batch, ensure_ascii=False),
                    utc_now_iso(),
                ),
            )

    def load_batch(self, batch_id: str) -> Record | None:
        self.initialize()
        with self._connect() as database:
            row = database.execute(
                "SELECT batch_json FROM batches WHERE batch_id=?", (batch_id,)
            ).fetchone()
        return cast(Record, json.loads(row[0])) if row else None

    def latest_batch(self) -> Record | None:
        self.initialize()
        with self._connect() as database:
            row = database.execute(
                "SELECT batch_json FROM batches ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        return cast(Record, json.loads(row[0])) if row else None

    def save_wiring_task(self, project_id: str, task: Record) -> None:
        with self._connect() as database:
            database.execute(
                "INSERT INTO wiring_tasks VALUES (?,?,?,?) ON CONFLICT(wiring_task_id) "
                "DO UPDATE SET task_json=excluded.task_json,updated_at=excluded.updated_at",
                (
                    task["wiringTaskId"],
                    project_id,
                    json.dumps(task, ensure_ascii=False),
                    utc_now_iso(),
                ),
            )

    def load_wiring_tasks(self, project_id: str) -> list[Record]:
        with self._connect() as database:
            rows = database.execute(
                "SELECT task_json FROM wiring_tasks WHERE project_id=?", (project_id,)
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def _connect(self) -> sqlite3.Connection:
        path = self.path()
        path.parent.mkdir(parents=True, exist_ok=True)
        database = sqlite3.connect(path)
        database.execute("PRAGMA journal_mode=WAL")
        return database

    def _index_run_artifacts(self) -> None:
        runs_path = self.path().parent / "runs"
        if not runs_path.exists():
            return
        with self._connect() as database:
            known = {row[0] for row in database.execute("SELECT run_id FROM runs").fetchall()}
            for summary_path in runs_path.glob("*/summary.json"):
                run_id = summary_path.parent.name
                if run_id in known:
                    continue
                try:
                    snapshot = json.loads(summary_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(snapshot, dict):
                    continue
                snapshot.setdefault("runId", run_id)
                if not isinstance(snapshot.get("planId"), str):
                    continue
                snapshot.setdefault("revision", 1)
                snapshot.setdefault("state", "completed")
                database.execute(
                    "INSERT OR IGNORE INTO runs VALUES (?,?,?,?,?,?,?)",
                    (
                        snapshot["runId"],
                        snapshot["planId"],
                        int(snapshot.get("revision", 1)),
                        snapshot.get("executionRevision"),
                        snapshot["state"],
                        json.dumps(snapshot, ensure_ascii=False),
                        str(
                            snapshot.get("completedAt")
                            or snapshot.get("startedAt")
                            or utc_now_iso()
                        ),
                    ),
                )

    @staticmethod
    def _run_summary(snapshot: Record) -> Record:
        keys = (
            "runId",
            "planId",
            "planName",
            "revision",
            "state",
            "verdict",
            "startedAt",
            "completedAt",
            "executionStatus",
            "cleanupStatus",
            "safetyStatus",
            "outcomeKnown",
            "recoveryRequired",
            "legacyClassification",
            "unitId",
            "batchId",
        )
        result = {key: clone(snapshot[key]) for key in keys if key in snapshot}
        result.setdefault("planName", str(snapshot.get("planId", "历史计划")))
        result.setdefault("verdict", "NotSet")
        result.setdefault("startedAt", str(snapshot.get("completedAt", "")))
        result.setdefault("cleanupStatus", "NotRequired")
        result.setdefault("executionStatus", "Succeeded")
        result.setdefault("safetyStatus", "NotRequired")
        result.setdefault("outcomeKnown", True)
        result.setdefault("recoveryRequired", False)
        return result

    @staticmethod
    def normalize_run(snapshot: Record) -> Record:
        result = clone(snapshot)
        legacy = "executionStatus" not in result or "safetyStatus" not in result
        state = str(result.get("state", "completed"))
        if "executionStatus" not in result:
            result["executionStatus"] = (
                "Aborted"
                if state == "aborted"
                else "Failed"
                if state == "error"
                else "Running"
                if state in {"starting", "running", "paused", "cleaning"}
                else "Succeeded"
            )
        result.setdefault("cleanupStatus", "NotRequired")
        result.setdefault(
            "safetyStatus", "Unknown" if result.get("recoveryRequired") else "NotRequired"
        )
        result.setdefault("outcomeKnown", True)
        result.setdefault("recoveryRequired", False)
        if legacy:
            result["legacyClassification"] = True
        return result

    @staticmethod
    def _encode_cursor(started_at: str, run_id: str) -> str:
        raw = json.dumps([started_at, run_id], separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    @staticmethod
    def _decode_cursor(cursor: str) -> tuple[str, str]:
        try:
            padded = cursor + "=" * (-len(cursor) % 4)
            value = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
            if not isinstance(value, list) or len(value) != 2:
                raise ValueError
            return str(value[0]), str(value[1])
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error) as error:
            raise app_error("invalid_argument", "Invalid test run cursor") from error

    @staticmethod
    def _recover_interrupted(database: sqlite3.Connection) -> None:
        now = utc_now_iso()
        database.execute(
            "UPDATE operations SET state='outcome_unknown',outcome_known=0,"
            "recovery_required=1,updated_at=? "
            "WHERE state='dispatched'",
            (now,),
        )
        database.execute(
            "UPDATE operations SET state='failed',updated_at=? WHERE state='accepted'", (now,)
        )
        for batch_id, raw in database.execute(
            "SELECT batch_id,batch_json FROM batches WHERE state='running'"
        ).fetchall():
            batch = json.loads(raw)
            batch.update({"state": "interrupted", "completedAt": now})
            for item in batch.get("items", []):
                if item.get("state") in {"queued", "running"}:
                    item["state"] = "skipped"
            database.execute(
                "UPDATE batches SET state='interrupted',batch_json=?,updated_at=? WHERE batch_id=?",
                (json.dumps(batch, ensure_ascii=False), now, batch_id),
            )
        rows = database.execute(
            "SELECT run_id,snapshot_json FROM runs "
            "WHERE state IN ('starting','running','paused','cleaning')"
        ).fetchall()
        for run_id, raw in rows:
            snapshot = json.loads(raw)
            snapshot.update(
                {
                    "state": "error",
                    "executionStatus": "Failed",
                    "cleanupStatus": "Unknown",
                    "safetyStatus": "Unknown",
                    "outcomeKnown": False,
                    "recoveryRequired": True,
                }
            )
            database.execute(
                "UPDATE runs SET state='error',snapshot_json=?,updated_at=? WHERE run_id=?",
                (json.dumps(snapshot, ensure_ascii=False), now, run_id),
            )

    def _import_legacy_requests(self, database: sqlite3.Connection) -> None:
        marker = database.execute(
            "SELECT value FROM metadata WHERE key='legacy_requests_imported'"
        ).fetchone()
        if marker:
            return
        legacy = self.path().parent / "testing-requests.json"
        if legacy.exists():
            try:
                value = json.loads(legacy.read_text(encoding="utf-8"))
                for scope, entries in value.get("requests", {}).items():
                    for request_id, entry in entries.items():
                        state = entry.get("state", "pending")
                        result = entry.get("result")
                        if state != "completed":
                            state = "needs_review"
                        now = entry.get("completedAt") or entry.get("claimedAt") or utc_now_iso()
                        database.execute(
                            "INSERT OR IGNORE INTO requests VALUES (?,?,?,?,?,?,?)",
                            (
                                scope,
                                request_id,
                                "legacy-unknown",
                                state,
                                json.dumps(result, ensure_ascii=False)
                                if result is not None
                                else None,
                                now,
                                now,
                            ),
                        )
            except (OSError, json.JSONDecodeError):
                pass
        database.execute("INSERT OR REPLACE INTO metadata VALUES ('legacy_requests_imported','1')")
