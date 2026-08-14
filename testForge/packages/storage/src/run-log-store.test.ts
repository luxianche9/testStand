import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestRunLogArchive } from "@testforge/contracts/orchestration";
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

describe("ProjectRunLogStore", () => {
  it("atomically saves and reloads one archive per Run", async () => {
    const projectRoot = await root();
    const store = new ProjectRunLogStore();
    await store.save(projectRoot, archive("RUN/A"));
    await store.save(projectRoot, archive("RUN-B", "2026-08-14T11:00:00.000Z"));

    const loaded = await store.load(projectRoot);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.archives.map((item) => item.run.runId).sort()).toEqual(["RUN-B", "RUN/A"]);
    const directory = join(projectRoot, ".testforge", "logs", "runs");
    expect(JSON.parse(await readFile(join(directory, "RUN%2FA.json"), "utf8"))).toMatchObject({ formatVersion: 1, run: { runId: "RUN/A" } });
  });

  it("reports corrupt, unsupported and semantically inconsistent files without failing the project", async () => {
    const projectRoot = await root();
    const directory = join(projectRoot, ".testforge", "logs", "runs");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "broken.json"), "{ nope", "utf8");
    await writeFile(join(directory, "future.json"), JSON.stringify({ ...archive("FUTURE"), formatVersion: 2 }), "utf8");
    const mismatched = archive("MISMATCH");
    mismatched.events[0]!.runId = "OTHER";
    await writeFile(join(directory, "mismatch.json"), JSON.stringify(mismatched), "utf8");
    await writeFile(join(directory, "ignore.txt"), "not a log", "utf8");

    const loaded = await new ProjectRunLogStore().load(projectRoot);
    expect(loaded.archives).toEqual([]);
    expect(loaded.warnings).toHaveLength(3);
    expect(loaded.warnings.join(" ")).toMatch(/broken\.json/);
    expect(loaded.warnings.join(" ")).toMatch(/future\.json/);
    expect(loaded.warnings.join(" ")).toMatch(/mismatch\.json/);
  });

  it("removes one Run or a selected group without touching other archives", async () => {
    const projectRoot = await root();
    const store = new ProjectRunLogStore();
    for (const runId of ["RUN1", "RUN2", "RUN3"]) await store.save(projectRoot, archive(runId));
    await store.remove(projectRoot, "RUN1");
    await store.clear(projectRoot, ["RUN2"]);
    expect((await store.load(projectRoot)).archives.map((item) => item.run.runId)).toEqual(["RUN3"]);
    await store.remove(projectRoot, "missing");
  });
});
