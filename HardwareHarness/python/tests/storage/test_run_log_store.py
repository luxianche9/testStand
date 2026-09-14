import time
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.compat import json_stringify
from hardwareharness_backend.storage import ProjectRunLogStore, RunLogStoreOptions

PREFIX = "packages/storage/src/run-log-store.test.ts::ProjectRunLogStore::"
STAMP = "2026-08-14T10:00:00.000Z"


def archive(run_id: str, created_at: str = STAMP) -> dict[str, Any]:
    return {
        "formatVersion": 1,
        "run": {
            "runId": run_id,
            "taskId": "TASK1",
            "taskName": "Voltage test",
            "projectId": "PROJECT1",
            "status": "passed",
            "inputs": {"target": 3.3},
            "createdAt": created_at,
            "startedAt": created_at,
            "completedAt": "2026-08-14T10:00:01.000Z",
            "summary": {"passedNodes": 1, "failedNodes": 0, "cancelledNodes": 0},
        },
        "nodeRuns": [
            {
                "nodeRunId": f"{run_id}-NODE",
                "runId": run_id,
                "nodeId": "STEP1",
                "nodeLabel": "Read",
                "nodeType": "tool",
                "status": "passed",
                "branchPath": "root",
                "iterationPath": [],
                "attempt": 1,
                "startedAt": created_at,
                "completedAt": "2026-08-14T10:00:01.000Z",
                "output": {"value": 3.3},
            }
        ],
        "events": [{"eventId": 1, "runId": run_id, "timestamp": created_at, "type": "run.started"}],
    }


async def persist(store: ProjectRunLogStore, root: Path, value: dict[str, Any]) -> None:
    await store.upsert_run(root, value["run"])
    for node in value["nodeRuns"]:
        await store.upsert_node_run(root, node)
    await store.append_events(root, value["run"]["runId"], value["events"])


@pytest.mark.ts_case(PREFIX + "appends and reloads one JSONL stream per Run")
@pytest.mark.asyncio
async def test_streams(tmp_path: Path) -> None:
    store = ProjectRunLogStore()
    await persist(store, tmp_path, archive("RUN/A"))
    await persist(store, tmp_path, archive("RUN-B", "2026-08-14T11:00:00.000Z"))
    result = await store.load(tmp_path)
    assert result["warnings"] == []
    assert sorted(item["run"]["runId"] for item in result["archives"]) == ["RUN-B", "RUN/A"]
    import json

    lines = (tmp_path / ".hardwareharness/logs/runs/RUN%2FA/run.jsonl").read_text().splitlines()
    assert [json.loads(line)["type"] for line in lines] == [
        "run.upsert",
        "nodeRun.upsert",
        "events.append",
    ]


@pytest.mark.ts_case(
    PREFIX + "reports corrupt records at line granularity and keeps valid Run streams"
)
@pytest.mark.asyncio
async def test_corrupt_lines(tmp_path: Path) -> None:
    root = tmp_path / ".hardwareharness/logs/runs"
    for name in ("broken", "future", "mismatch"):
        (root / name).mkdir(parents=True)
    (root / "broken/run.jsonl").write_text(
        "{ nope\n"
        + json_stringify({"formatVersion": 1, "type": "run.upsert", "run": archive("GOOD")["run"]})
        + "\n"
    )
    (root / "future/run.jsonl").write_text(
        json_stringify({"formatVersion": 2, "type": "run.upsert", "run": archive("FUTURE")["run"]})
        + "\n"
    )
    (root / "mismatch/run.jsonl").write_text(
        json_stringify(
            {"formatVersion": 1, "type": "run.upsert", "run": archive("MISMATCH")["run"]}
        )
        + "\n"
        + json_stringify(
            {
                "formatVersion": 1,
                "type": "events.append",
                "runId": "OTHER",
                "events": archive("MISMATCH")["events"],
            }
        )
        + "\n"
    )
    (root / "ignore.txt").write_text("not a log")
    result = await ProjectRunLogStore().load(tmp_path)
    assert sorted(item["run"]["runId"] for item in result["archives"]) == ["GOOD", "MISMATCH"]
    assert len(result["warnings"]) == 4
    assert all(
        text in " ".join(result["warnings"])
        for text in ("broken/run.jsonl:1", "future/run.jsonl:1", "mismatch/run.jsonl:2")
    )


@pytest.mark.ts_case(
    PREFIX + "deduplicates retried event appends and compacts to an atomic snapshot"
)
@pytest.mark.asyncio
async def test_compaction(tmp_path: Path) -> None:
    writes: list[dict[str, Any]] = []
    store = ProjectRunLogStore({"compactAfterBytes": 1, "onWrite": writes.append})
    value = archive("RUN1")
    await persist(store, tmp_path, value)
    await store.append_events(tmp_path, "RUN1", value["events"])
    snapshot = {
        "formatVersion": 1,
        "runId": "RUN1",
        "task": {
            "formatVersion": 2,
            "taskId": "TASK1",
            "name": "Voltage test",
            "inputs": [],
            "variables": [],
            "setup": [],
            "steps": [],
            "cleanup": [],
        },
        "workflowContext": {},
        "phase": "main",
        "machine": {"status": "active", "value": "running", "context": {"runId": "RUN1"}},
        "updatedAt": STAMP,
    }
    await store.upsert_execution_snapshot(tmp_path, snapshot)
    result = await store.load(tmp_path)
    assert result == {"archives": [value], "snapshots": [snapshot], "warnings": []}
    assert any(write["kind"] == "snapshot" for write in writes)
    assert (tmp_path / ".hardwareharness/logs/runs/RUN1/run.jsonl").stat().st_size == 0
    assert (
        '"runId": "RUN1"'
        in (tmp_path / ".hardwareharness/logs/runs/RUN1/snapshot.json").read_text()
    )


@pytest.mark.ts_case(PREFIX + "migrates legacy archives and removes one Run or a selected group")
@pytest.mark.asyncio
async def test_legacy_and_remove(tmp_path: Path) -> None:
    directory = tmp_path / ".hardwareharness/logs/runs"
    directory.mkdir(parents=True)
    (directory / "RUN1.json").write_text(json_stringify(archive("RUN1")))
    store = ProjectRunLogStore()
    for run in ("RUN2", "RUN3"):
        await persist(store, tmp_path, archive(run))
    assert sorted(item["run"]["runId"] for item in (await store.load(tmp_path))["archives"]) == [
        "RUN1",
        "RUN2",
        "RUN3",
    ]
    assert '"runId": "RUN1"' in (directory / "RUN1/snapshot.json").read_text()
    assert not (directory / "RUN1.json").exists()
    await store.remove(tmp_path, "RUN1")
    await store.clear(tmp_path, ["RUN2"])
    assert [item["run"]["runId"] for item in (await store.load(tmp_path))["archives"]] == ["RUN3"]
    await store.remove(tmp_path, "missing")


@pytest.mark.ts_case(
    PREFIX + "keeps large Run persistence linear instead of rewriting the full archive"
)
@pytest.mark.asyncio
async def test_linear_bytes(tmp_path: Path) -> None:
    writes: list[dict[str, Any]] = []
    store = ProjectRunLogStore({"compactAfterBytes": 16 * 1024 * 1024, "onWrite": writes.append})
    value = archive("LARGE")
    await store.upsert_run(tmp_path, value["run"])
    events = [
        {
            "eventId": index + 1,
            "runId": "LARGE",
            "timestamp": STAMP,
            "type": "sample",
            "data": {"index": index, "payload": "x" * 64},
        }
        for index in range(1000)
    ]
    start = time.monotonic()
    for offset in range(0, 1000, 100):
        await store.append_events(tmp_path, "LARGE", events[offset : offset + 100])
    assert time.monotonic() - start < 10
    assert len((await store.load(tmp_path))["archives"][0]["events"]) == 1000
    # Exactly the original sum of 1000 growing archive JSON lengths, without
    # re-encoding every preceding event on each iteration of the test oracle.
    empty_bytes = len(json_stringify({**value, "nodeRuns": [], "events": []}).encode())
    rewrite_bytes = 0
    event_bytes = 0
    for index, event in enumerate(events):
        event_bytes += len(json_stringify(event).encode())
        rewrite_bytes += empty_bytes + event_bytes + index
    assert sum(write["bytes"] for write in writes if write["kind"] == "append") * 50 < rewrite_bytes


@pytest.mark.parametrize("run_id", [".", ".."])
@pytest.mark.asyncio
async def test_dot_run_never_operates_on_parent(tmp_path: Path, run_id: str) -> None:
    store = ProjectRunLogStore()
    await persist(store, tmp_path, archive("SAFE"))
    before = (tmp_path / ".hardwareharness/logs/runs/SAFE/run.jsonl").read_bytes()
    with pytest.raises(ValueError, match="Invalid Run id"):
        await store.remove(tmp_path, run_id)
    with pytest.raises(ValueError, match="Invalid Run id"):
        await store.clear(tmp_path, [run_id])
    assert (tmp_path / ".hardwareharness/logs/runs/SAFE/run.jsonl").read_bytes() == before
    legacy = tmp_path / ".hardwareharness/logs/runs/legacy.json"
    legacy.write_text(json_stringify(archive(run_id)))
    result = await store.load(tmp_path)
    assert any("Invalid Run id" in warning for warning in result["warnings"])
    assert legacy.exists()


@pytest.mark.asyncio
async def test_load_empty_duplicate_legacy_and_recovery(tmp_path: Path) -> None:
    store = ProjectRunLogStore(RunLogStoreOptions(compact_after_bytes=1))
    assert await store.load(tmp_path) == {"archives": [], "snapshots": [], "warnings": []}
    await persist(store, tmp_path, archive("R"))
    directory = tmp_path / ".hardwareharness/logs/runs"
    (directory / "R.json").write_text(json_stringify(archive("R")))
    (directory / "broken.json").write_text("not JSON")
    loaded = await store.load(tmp_path)
    assert len(loaded["archives"]) == 1
    assert len(loaded["warnings"]) == 2
    assert "ignored legacy archive" in " ".join(loaded["warnings"])
    (directory / "R/snapshot.json").write_text('{"formatVersion":99}')
    await store.upsert_run(tmp_path, archive("R")["run"])
    loaded = await store.load(tmp_path)
    assert len(loaded["archives"]) == 1
    assert "Unsupported snapshot formatVersion" in " ".join(loaded["warnings"])
    assert (directory / "R/run.jsonl").stat().st_size > 0


@pytest.mark.asyncio
async def test_record_validation_and_archive_mismatch(tmp_path: Path) -> None:
    store = ProjectRunLogStore({"compactAfterBytes": float("inf")})
    await store.append_events(tmp_path, "R", [])
    assert not (tmp_path / ".hardwareharness").exists()
    with pytest.raises(RuntimeError, match="Event Run id does not match R"):
        await store.append_events(tmp_path, "R", archive("OTHER")["events"])
    directory = tmp_path / ".hardwareharness/logs/runs/records"
    directory.mkdir(parents=True)
    records = [
        None,
        {"formatVersion": 1, "type": "unknown"},
        {"formatVersion": 1, "type": "events.append", "runId": "R", "events": None},
        {"formatVersion": 1, "type": "run.upsert", "run": archive("R")["run"]},
        {"formatVersion": 1, "type": "nodeRun.upsert", "nodeRun": archive("OTHER")["nodeRuns"][0]},
    ]
    (directory / "run.jsonl").write_text("\n".join(json_stringify(record) for record in records))
    loaded = await store.load(tmp_path)
    assert loaded["archives"] == []
    assert len(loaded["warnings"]) == 4
    assert "node Run id does not match archive Run" in " ".join(loaded["warnings"])


@pytest.mark.asyncio
async def test_replay_preserves_node_order_and_last_event_value(tmp_path: Path) -> None:
    store = ProjectRunLogStore()
    value = archive("R")
    await persist(store, tmp_path, value)
    first = value["nodeRuns"][0]
    await store.upsert_node_run(tmp_path, {**first, "nodeRunId": "SECOND"})
    await store.upsert_node_run(tmp_path, {**first, "output": {"value": 7}})
    event = value["events"][0]
    await store.append_events(
        tmp_path, "R", [{**event, "eventId": 3}, {**event, "type": "updated"}]
    )
    loaded = (await store.load(tmp_path))["archives"][0]
    assert [node["nodeRunId"] for node in loaded["nodeRuns"]] == ["R-NODE", "SECOND"]
    assert loaded["nodeRuns"][0]["output"] == {"value": 7}
    assert [item["eventId"] for item in loaded["events"]] == [1, 3]
    assert loaded["events"][0]["type"] == "updated"
