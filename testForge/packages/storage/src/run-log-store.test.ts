import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestRunEvent, TestRunExecutionSnapshot, TestRunLogArchive } from "@testforge/contracts/orchestration";
import { ProjectRunLogStore } from "./run-log-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "testforge-run-logs-"));
  roots.push(value);
  return value;
}

function archive(runId: string, createdAt = "2026-08-14T10:00:00.000Z"): TestRunLogArchive {
  return {
    formatVersion: 1,
    run: {
      runId,
      taskId: "TASK1",
      taskName: "Voltage test",
      projectId: "PROJECT1",
      status: "passed",
      inputs: { target: 3.3 },
      createdAt,
      startedAt: createdAt,
      completedAt: "2026-08-14T10:00:01.000Z",
      summary: { passedNodes: 1, failedNodes: 0, cancelledNodes: 0 }
    },
    nodeRuns: [{
      nodeRunId: `${runId}-NODE`, runId, nodeId: "STEP1", nodeLabel: "Read", nodeType: "tool", status: "passed",
      branchPath: "root", iterationPath: [], attempt: 1, startedAt: createdAt, completedAt: "2026-08-14T10:00:01.000Z", output: { value: 3.3 }
    }],
    events: [{ eventId: 1, runId, timestamp: createdAt, type: "run.started" }]
  };
}

async function persistArchive(store: ProjectRunLogStore, projectRoot: string, value: TestRunLogArchive): Promise<void> {
  await store.upsertRun(projectRoot, value.run);
  for (const nodeRun of value.nodeRuns) await store.upsertNodeRun(projectRoot, nodeRun);
  await store.appendEvents(projectRoot, value.run.runId, value.events);
}

function executionSnapshot(runId: string): TestRunExecutionSnapshot {
  return {
    formatVersion: 1,
    runId,
    task: { formatVersion: 2, taskId: "TASK1", name: "Voltage test", inputs: [], variables: [], setup: [], steps: [], cleanup: [] },
    workflowContext: {},
    phase: "main",
    machine: { status: "active", value: "running", context: { runId } },
    updatedAt: "2026-08-14T10:00:00.000Z"
  };
}

describe("ProjectRunLogStore", () => {
  it("appends and reloads one JSONL stream per Run", async () => {
    const projectRoot = await root();
    const store = new ProjectRunLogStore();
    await persistArchive(store, projectRoot, archive("RUN/A"));
    await persistArchive(store, projectRoot, archive("RUN-B", "2026-08-14T11:00:00.000Z"));

    const loaded = await store.load(projectRoot);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.archives.map((item) => item.run.runId).sort()).toEqual(["RUN-B", "RUN/A"]);
    const path = join(projectRoot, ".testforge", "logs", "runs", "RUN%2FA", "run.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(lines.map((line) => line.type)).toEqual(["run.upsert", "nodeRun.upsert", "events.append"]);
  });

  it("reports corrupt records at line granularity and keeps valid Run streams", async () => {
    const projectRoot = await root();
    const directory = join(projectRoot, ".testforge", "logs", "runs");
    const broken = join(directory, "broken");
    const future = join(directory, "future");
    const mismatch = join(directory, "mismatch");
    await Promise.all([broken, future, mismatch].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(broken, "run.jsonl"), `{ nope\n${JSON.stringify({ formatVersion: 1, type: "run.upsert", run: archive("GOOD").run })}\n`, "utf8");
    await writeFile(join(future, "run.jsonl"), `${JSON.stringify({ formatVersion: 2, type: "run.upsert", run: archive("FUTURE").run })}\n`, "utf8");
    await writeFile(join(mismatch, "run.jsonl"), [
      JSON.stringify({ formatVersion: 1, type: "run.upsert", run: archive("MISMATCH").run }),
      JSON.stringify({ formatVersion: 1, type: "events.append", runId: "OTHER", events: archive("MISMATCH").events })
    ].join("\n") + "\n", "utf8");
    await writeFile(join(directory, "ignore.txt"), "not a log", "utf8");

    const loaded = await new ProjectRunLogStore().load(projectRoot);
    expect(loaded.archives.map((item) => item.run.runId).sort()).toEqual(["GOOD", "MISMATCH"]);
    expect(loaded.warnings).toHaveLength(4);
    expect(loaded.warnings.join(" ")).toMatch(/broken\/run\.jsonl:1/);
    expect(loaded.warnings.join(" ")).toMatch(/future\/run\.jsonl:1/);
    expect(loaded.warnings.join(" ")).toMatch(/mismatch\/run\.jsonl:2/);
  });

  it("deduplicates retried event appends and compacts to an atomic snapshot", async () => {
    const projectRoot = await root();
    const writes: { kind: "append" | "snapshot"; bytes: number }[] = [];
    const store = new ProjectRunLogStore({ compactAfterBytes: 1, onWrite: (write) => writes.push(write) });
    const value = archive("RUN1");
    await store.upsertRun(projectRoot, value.run);
    await store.upsertNodeRun(projectRoot, value.nodeRuns[0]!);
    await store.appendEvents(projectRoot, value.run.runId, value.events);
    await store.appendEvents(projectRoot, value.run.runId, value.events);
    await store.upsertExecutionSnapshot(projectRoot, executionSnapshot("RUN1"));

    const loaded = await store.load(projectRoot);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.archives[0]).toEqual(value);
    expect(loaded.snapshots).toEqual([executionSnapshot("RUN1")]);
    expect(writes.some((write) => write.kind === "snapshot")).toBe(true);
    const directory = join(projectRoot, ".testforge", "logs", "runs", "RUN1");
    expect(JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"))).toMatchObject({ formatVersion: 1, archive: { run: { runId: "RUN1" } } });
    expect((await stat(join(directory, "run.jsonl"))).size).toBe(0);
  });

  it("migrates legacy archives and removes one Run or a selected group", async () => {
    const projectRoot = await root();
    const directory = join(projectRoot, ".testforge", "logs", "runs");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "RUN1.json"), JSON.stringify(archive("RUN1")), "utf8");
    const store = new ProjectRunLogStore();
    await persistArchive(store, projectRoot, archive("RUN2"));
    await persistArchive(store, projectRoot, archive("RUN3"));

    expect((await store.load(projectRoot)).archives.map((item) => item.run.runId).sort()).toEqual(["RUN1", "RUN2", "RUN3"]);
    expect(await readFile(join(directory, "RUN1", "snapshot.json"), "utf8")).toContain('"runId": "RUN1"');
    await expect(readFile(join(directory, "RUN1.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await store.remove(projectRoot, "RUN1");
    await store.clear(projectRoot, ["RUN2"]);
    expect((await store.load(projectRoot)).archives.map((item) => item.run.runId)).toEqual(["RUN3"]);
    await store.remove(projectRoot, "missing");
  });

  it("keeps large Run persistence linear instead of rewriting the full archive", async () => {
    const projectRoot = await root();
    let appendedBytes = 0;
    const store = new ProjectRunLogStore({ compactAfterBytes: 16 * 1024 * 1024, onWrite: (write) => { if (write.kind === "append") appendedBytes += write.bytes; } });
    const value = archive("LARGE");
    await store.upsertRun(projectRoot, value.run);
    const events: TestRunEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
      eventId: index + 1,
      runId: "LARGE",
      timestamp: "2026-08-14T10:00:00.000Z",
      type: "sample",
      data: { index, payload: "x".repeat(64) }
    }));
    const startedAt = performance.now();
    for (let offset = 0; offset < events.length; offset += 100) await store.appendEvents(projectRoot, "LARGE", events.slice(offset, offset + 100));
    const elapsedMs = performance.now() - startedAt;
    const finalArchive = { ...value, nodeRuns: [], events } satisfies TestRunLogArchive;
    const legacyRewriteBytes = events.reduce((total, _event, index) => total + Buffer.byteLength(JSON.stringify({ ...finalArchive, events: events.slice(0, index + 1) }), "utf8"), 0);

    expect((await store.load(projectRoot)).archives[0]?.events).toHaveLength(1_000);
    expect(appendedBytes * 50).toBeLessThan(legacyRewriteBytes);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
