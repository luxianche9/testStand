import { describe, expect, it, vi } from "vitest";
import type { ActiveExecutionActivity } from "@testforge/contracts/execution";
import type { TestRunLogArchive, TestTask } from "@testforge/contracts/orchestration";
import {
  TaskOrchestrationService,
  type OrchestrationExecutionLease,
  type OrchestrationExecutionPort,
  type OrchestrationRunLogPort
} from "./task-orchestration-service.js";

const tool = {
  externalName: "SERVER1__measure",
  remoteName: "measure",
  serverId: "SERVER1",
  description: "Fixture measurement",
  inputSchema: { type: "object", properties: { hardwareId: { type: "string" }, value: { type: "number" } }, required: ["hardwareId", "value"] },
  schemaHash: "hash",
  kind: "hardware"
};

function testTask(name = "Voltage test"): TestTask {
  return {
    formatVersion: 2,
    taskId: "TASK1",
    name,
    inputs: [{ name: "payload", type: "string", defaultValue: "default" }],
    variables: [],
    setup: [],
    steps: [{
      stepId: "STEP1", label: "Measure", enabled: true, type: "tool", toolName: tool.externalName, hardwareId: "HW1",
      arguments: { value: { kind: "literal", value: 3.3 } }, outputBindings: [], timeoutMs: 30_000, retry: { maxAttempts: 1, delayMs: 0 }
    }],
    cleanup: []
  };
}

class MemoryExecution implements OrchestrationExecutionPort {
  activity: "idle" | "manual" | "run" = "idle";
  releases = 0;

  assertIdle(): void {
    if (this.activity !== "idle") throw Object.assign(new Error(`${this.activity} execution is active`), { category: "conflict" });
  }

  acquire(activity: ActiveExecutionActivity): OrchestrationExecutionLease {
    this.assertIdle();
    this.activity = activity.state;
    let released = false;
    return { release: () => { if (released) return; released = true; this.releases += 1; this.activity = "idle"; } };
  }
}

class MemoryRunLogs implements OrchestrationRunLogPort {
  readonly archives = new Map<string, TestRunLogArchive>();
  warnings: string[] = [];
  readonly save = vi.fn(async (_rootPath: string, archive: TestRunLogArchive) => { this.archives.set(archive.run.runId, structuredClone(archive)); });
  readonly remove = vi.fn(async (_rootPath: string, runId: string) => { this.archives.delete(runId); });
  readonly clear = vi.fn(async (_rootPath: string, runIds: string[]) => { for (const runId of runIds) this.archives.delete(runId); });
  async load(): Promise<{ archives: TestRunLogArchive[]; warnings: string[] }> {
    return { archives: [...this.archives.values()].map((item) => structuredClone(item)), warnings: [...this.warnings] };
  }
}

function fixture(options: {
  task?: TestTask;
  callTool?: (name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;
  logs?: MemoryRunLogs;
  execution?: MemoryExecution;
  canvas?: boolean;
} = {}) {
  let task = options.task ?? testTask();
  const execution = options.execution ?? new MemoryExecution();
  const logs = options.logs ?? new MemoryRunLogs();
  const projects = {
    task: () => structuredClone(task),
    wiring: () => ({ nodes: options.canvas === false ? [] : [{ hardwareId: "HW1", x: 0, y: 0, showImage: true, portPositions: {} }], connections: [] }),
    updateTask: (next: TestTask) => { task = structuredClone(next); return { dirty: true, file: { task } }; },
    projectId: () => "PROJECT1",
    session: () => ({ projectId: "PROJECT1", rootPath: "C:\\project" })
  };
  const tools = {
    listTools: () => [tool],
    callTool: options.callTool ?? (async () => ({ value: 3.3 }))
  };
  const catalog = { getHardware: () => ({ formatVersion: 2, hardwareId: "HW1", label: "HW1", kind: "managed", serverId: "SERVER1", computerId: "PC1", ports: [] }) };
  const service = new TaskOrchestrationService(projects as never, tools as never, catalog as never, "test", execution, logs);
  return { service, execution, logs, projects, setTask: (next: TestTask) => { task = structuredClone(next); } };
}

function storedRun(runId: string, status: "passed" | "failed" | "blocked" | "running", createdAt: string, taskName: string): TestRunLogArchive {
  return {
    formatVersion: 1,
    run: {
      runId, taskId: "TASK1", taskName, projectId: "PROJECT1", status, inputs: {}, createdAt,
      ...(status === "running" ? { startedAt: createdAt } : { completedAt: createdAt, summary: { passedNodes: status === "passed" ? 1 : 0, failedNodes: status === "failed" ? 1 : 0, cancelledNodes: 0 } })
    },
    nodeRuns: [],
    events: [{ eventId: Number(runId.replace(/\D/g, "")) || 1, runId, timestamp: createdAt, type: `run.${status}` }]
  };
}

describe("TaskOrchestrationService Run logs", () => {
  it("persists completed Runs with task-name snapshots and UTF-8 bounded values, then reloads them", async () => {
    const huge = "测".repeat(40_000);
    const logs = new MemoryRunLogs();
    const first = fixture({ logs, callTool: async () => ({ payload: huge }) });
    await first.service.initialize();
    const started = await first.service.startRun({ inputs: { payload: huge } });
    await vi.waitFor(() => expect(first.service.getRun(started.run.runId).run.status).toBe("passed"));
    first.setTask(testTask("Renamed later"));
    await first.service.close();

    const saved = logs.archives.get(started.run.runId)!;
    expect(saved.run.taskName).toBe("Voltage test");
    expect(saved.run.inputs).toMatchObject({ truncated: true, bytes: expect.any(Number), preview: expect.any(String) });
    expect(saved.nodeRuns[0]?.output).toMatchObject({ truncated: true, bytes: expect.any(Number), preview: expect.any(String) });
    expect((saved.run.inputs as { bytes: number }).bytes).toBeGreaterThan(100_000);

    const second = fixture({ logs, task: testTask("Renamed later") });
    await second.service.initialize();
    expect(second.service.listRuns().items[0]).toMatchObject({ runId: started.run.runId, taskName: "Voltage test", status: "passed" });
    expect(second.service.exportRun(started.run.runId)).toEqual(saved);
    await second.service.close();
  });

  it("marks a persisted active Run interrupted and appends a recovery event", async () => {
    const logs = new MemoryRunLogs();
    logs.archives.set("RUN9", storedRun("RUN9", "running", "2026-08-14T09:00:00.000Z", "Recovered task"));
    const { service } = fixture({ logs });
    await service.initialize();
    const detail = service.getRun("RUN9");
    expect(detail.run.status).toBe("interrupted");
    expect(detail.run.completedAt).toBeDefined();
    expect(detail.events.at(-1)).toMatchObject({ type: "run.interrupted", data: { reason: "application_restart" } });
    expect(logs.archives.get("RUN9")?.run.status).toBe("interrupted");
    await service.close();
  });

  it("filters, pages, exports, deletes and clears project-isolated history", async () => {
    const logs = new MemoryRunLogs();
    logs.warnings = ["broken.json: invalid JSON"];
    logs.archives.set("RUN1", storedRun("RUN1", "passed", "2026-08-10T10:00:00.000Z", "Alpha"));
    logs.archives.set("RUN2", storedRun("RUN2", "failed", "2026-08-12T10:00:00.000Z", "Beta"));
    logs.archives.set("RUN3", storedRun("RUN3", "blocked", "2026-08-13T10:00:00.000Z", "Alpha retry"));
    logs.archives.set("FOREIGN", { ...storedRun("FOREIGN", "passed", "2026-08-14T10:00:00.000Z", "Foreign"), run: { ...storedRun("FOREIGN", "passed", "2026-08-14T10:00:00.000Z", "Foreign").run, projectId: "OTHER" } });
    const { service } = fixture({ logs });
    await service.initialize();

    expect(service.listRuns({ search: "alpha" }).total).toBe(2);
    expect(service.listRuns({ statuses: ["failed"] }).items.map((item) => item.runId)).toEqual(["RUN2"]);
    expect(service.listRuns({ from: "2026-08-12T00:00:00.000Z", to: "2026-08-13T23:59:59.999Z" }).total).toBe(2);
    expect(service.listRuns({ offset: 1, limit: 1 }).items[0]?.runId).toBe("RUN2");
    expect(service.listRuns().warnings).toEqual(expect.arrayContaining(["broken.json: invalid JSON", expect.stringContaining("projectId") ]));
    expect(service.exportRun("RUN1").run.taskName).toBe("Alpha");

    await service.deleteRun("RUN1");
    expect(logs.remove).toHaveBeenCalledWith("C:\\project", "RUN1");
    expect(() => service.getRun("RUN1")).toThrow(/Unknown runId/);
    expect(await service.clearCompletedRuns()).toEqual({ deleted: 2 });
    expect(service.listRuns().total).toBe(0);
    await service.close();
  });

  it("waits for pending persistence before deleting so a background save cannot recreate the file", async () => {
    let releaseFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    class BlockingLogs extends MemoryRunLogs {
      override readonly save = vi.fn(async (_rootPath: string, archive: TestRunLogArchive) => {
        if (this.save.mock.calls.length === 1) await firstSave;
        this.archives.set(archive.run.runId, structuredClone(archive));
      });
    }
    const logs = new BlockingLogs();
    const { service } = fixture({ logs, canvas: false });
    await service.initialize();
    const blocked = await service.startRun();
    await vi.waitFor(() => expect(logs.save).toHaveBeenCalled());
    const deletion = service.deleteRun(blocked.run.runId);
    await Promise.resolve();
    expect(logs.remove).not.toHaveBeenCalled();
    releaseFirstSave();
    await deletion;
    expect(logs.remove).toHaveBeenCalledTimes(1);
    expect(logs.archives.has(blocked.run.runId)).toBe(false);
    await service.close();
  });
});

describe("TaskOrchestrationService execution activity", () => {
  it("returns conflict before preflight when a manual call is active", async () => {
    const execution = new MemoryExecution();
    execution.activity = "manual";
    const { service, logs } = fixture({ execution, canvas: false });
    await service.initialize();
    await expect(service.startRun()).rejects.toMatchObject({ category: "conflict" });
    expect(logs.archives.size).toBe(0);
  });

  it("holds the Run lease until cancellation completes and releases it afterward", async () => {
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const { service, execution } = fixture({ callTool });
    await service.initialize();
    const started = await service.startRun();
    await vi.waitFor(() => expect(execution.activity).toBe("run"));
    await expect(service.startRun()).rejects.toMatchObject({ category: "conflict" });
    await service.cancelRun(started.run.runId);
    await vi.waitFor(() => expect(service.getRun(started.run.runId).run.status).toBe("cancelled"));
    expect(execution.activity).toBe("idle");
    expect(execution.releases).toBe(1);
    await service.close();
  });

  it("marks an active Run interrupted and releases its lease during close", async () => {
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const { service, execution } = fixture({ callTool });
    await service.initialize();
    const started = await service.startRun();
    await service.close();
    expect(service.getRun(started.run.runId).run.status).toBe("interrupted");
    expect(execution.activity).toBe("idle");
    expect(execution.releases).toBe(1);
  });

  it("rejects a queued start while close waits for start operations", async () => {
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const { service, execution } = fixture({ callTool });
    await service.initialize();
    const started = await service.startRun();

    const queued = service.startRun();
    const closing = service.close();

    await expect(queued).rejects.toMatchObject({ category: "conflict" });
    await closing;
    expect(service.getRun(started.run.runId).run.status).toBe("interrupted");
    expect(service.listRuns().items).toHaveLength(1);
    expect(execution.activity).toBe("idle");
  });
});
