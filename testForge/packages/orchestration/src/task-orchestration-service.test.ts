import { describe, expect, it, vi } from "vitest";
import type { ActiveExecutionActivity } from "@testforge/contracts/execution";
import { appError } from "@testforge/contracts/errors";
import type { TestNodeRun, TestRun, TestRunEvent, TestRunExecutionSnapshot, TestRunLogArchive, TestStep, TestTask } from "@testforge/contracts/orchestration";
import {
  TaskOrchestrationService,
  type OrchestrationExecutionLease,
  type OrchestrationExecutionPort,
  type OrchestrationRunLogPort,
  type OrchestrationSafetyOptions
} from "./task-orchestration-service.js";

const tool = {
  externalName: "SERVER1__measure",
  remoteName: "measure",
  serverId: "SERVER1",
  description: "Fixture measurement",
  inputSchema: { type: "object", properties: { hardwareId: { type: "string" }, value: { type: "number" } }, required: ["hardwareId", "value"] },
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
      arguments: { value: { kind: "literal", value: 3.3 } }, outputBindings: [], timeoutMs: 30_000, idempotent: false, retry: { maxAttempts: 1, delayMs: 0, backoff: "fixed", retryOn: ["unavailable"] }
    }],
    cleanup: []
  };
}

function firstTool(task: TestTask): Extract<TestStep, { type: "tool" }> {
  const step = task.steps[0];
  if (step?.type !== "tool") throw new Error("Expected the fixture task to start with a tool step");
  return step;
}

class MemoryExecution implements OrchestrationExecutionPort {
  private readonly holders = new Map<string, ActiveExecutionActivity>();
  releases = 0;

  get activity(): "idle" | "manual" | "run" {
    const activities = [...new Set(this.holders.values())];
    return activities.find((activity) => activity.state === "run")?.state ?? activities[0]?.state ?? "idle";
  }

  acquire(activity: ActiveExecutionActivity): OrchestrationExecutionLease {
    const hardwareIds = activity.state === "manual" ? [activity.hardwareId] : [...new Set(activity.hardwareIds)];
    if (hardwareIds.some((hardwareId) => this.holders.has(hardwareId))) {
      throw Object.assign(new Error("hardware execution is active"), { category: "conflict" });
    }
    for (const hardwareId of hardwareIds) this.holders.set(hardwareId, activity);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.releases += 1;
      for (const hardwareId of hardwareIds) if (this.holders.get(hardwareId) === activity) this.holders.delete(hardwareId);
    } };
  }
}

class MemoryRunLogs implements OrchestrationRunLogPort {
  readonly archives = new Map<string, TestRunLogArchive>();
  readonly snapshots = new Map<string, TestRunExecutionSnapshot>();
  warnings: string[] = [];
  readonly upsertRun = vi.fn(async (_rootPath: string, run: TestRun) => {
    const current = this.archives.get(run.runId);
    this.archives.set(run.runId, { formatVersion: 1, run: structuredClone(run), nodeRuns: current?.nodeRuns ?? [], events: current?.events ?? [] });
  });
  readonly upsertNodeRun = vi.fn(async (_rootPath: string, nodeRun: TestNodeRun) => {
    const current = this.archives.get(nodeRun.runId);
    if (!current) throw new Error(`Run ${nodeRun.runId} must be persisted before its nodes`);
    const index = current.nodeRuns.findIndex((item) => item.nodeRunId === nodeRun.nodeRunId);
    if (index < 0) current.nodeRuns.push(structuredClone(nodeRun));
    else current.nodeRuns[index] = structuredClone(nodeRun);
  });
  readonly appendEvents = vi.fn(async (_rootPath: string, runId: string, events: TestRunEvent[]) => {
    const current = this.archives.get(runId);
    if (!current) throw new Error(`Run ${runId} must be persisted before its events`);
    const byId = new Map(current.events.map((event) => [event.eventId, event]));
    for (const event of events) byId.set(event.eventId, structuredClone(event));
    current.events = [...byId.values()].sort((left, right) => left.eventId - right.eventId);
  });
  readonly upsertExecutionSnapshot = vi.fn(async (_rootPath: string, snapshot: TestRunExecutionSnapshot) => {
    this.snapshots.set(snapshot.runId, structuredClone(snapshot));
  });
  readonly remove = vi.fn(async (_rootPath: string, runId: string) => { this.archives.delete(runId); this.snapshots.delete(runId); });
  readonly clear = vi.fn(async (_rootPath: string, runIds: string[]) => { for (const runId of runIds) { this.archives.delete(runId); this.snapshots.delete(runId); } });
  async load(): Promise<{ archives: TestRunLogArchive[]; snapshots: TestRunExecutionSnapshot[]; warnings: string[] }> {
    return {
      archives: [...this.archives.values()].map((item) => structuredClone(item)),
      snapshots: [...this.snapshots.values()].map((item) => structuredClone(item)),
      warnings: [...this.warnings]
    };
  }
}

function fixture(options: {
  task?: TestTask;
  callTool?: (name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal; metadata?: { hardwareId: string; attempt?: number; idempotencyKey?: string } }) => Promise<unknown>;
  logs?: MemoryRunLogs;
  execution?: MemoryExecution;
  canvas?: boolean;
  safety?: OrchestrationSafetyOptions;
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
  const service = new TaskOrchestrationService(projects as never, tools as never, catalog as never, execution, logs, options.safety);
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
    expect(service.listRuns({ taskName: "Alpha" }).items.map((item) => item.runId)).toEqual(["RUN1"]);
    expect(service.listRuns().taskNames).toEqual(["Alpha", "Alpha retry", "Beta"]);
    expect(service.listRuns({ sortBy: "taskName", sortDir: "asc" }).items.map((item) => item.taskName)).toEqual(["Alpha", "Alpha retry", "Beta"]);
    expect(service.listRuns({ sortBy: "status", sortDir: "asc" }).items.map((item) => item.status)).toEqual(["blocked", "failed", "passed"]);
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
      override readonly upsertRun = vi.fn(async (_rootPath: string, run: TestRun) => {
        if (this.upsertRun.mock.calls.length === 1) await firstSave;
        const current = this.archives.get(run.runId);
        this.archives.set(run.runId, { formatVersion: 1, run: structuredClone(run), nodeRuns: current?.nodeRuns ?? [], events: current?.events ?? [] });
      });
    }
    const logs = new BlockingLogs();
    const { service } = fixture({ logs, canvas: false });
    await service.initialize();
    const blocked = await service.startRun();
    await vi.waitFor(() => expect(logs.upsertRun).toHaveBeenCalled());
    const deletion = service.deleteRun(blocked.run.runId);
    await Promise.resolve();
    expect(logs.remove).not.toHaveBeenCalled();
    releaseFirstSave();
    await deletion;
    expect(logs.remove).toHaveBeenCalledTimes(1);
    expect(logs.archives.has(blocked.run.runId)).toBe(false);
    await service.close();
  });

  it("uses event ids that are monotonic within each Run instead of globally", async () => {
    const logs = new MemoryRunLogs();
    const { service } = fixture({ logs, canvas: false });
    await service.initialize();
    const first = await service.startRun();
    const second = await service.startRun();
    await service.close();

    expect(first.events.map((event) => event.eventId)).toEqual([1]);
    expect(second.events.map((event) => event.eventId)).toEqual([1]);
    expect(logs.archives.get(first.run.runId)?.events.map((event) => event.eventId)).toEqual([1]);
    expect(logs.archives.get(second.run.runId)?.events.map((event) => event.eventId)).toEqual([1]);
  });

  it("requeues a failed incremental write with backoff instead of silently losing it", async () => {
    let failed = false;
    class FlakyLogs extends MemoryRunLogs {
      override readonly upsertRun = vi.fn(async (_rootPath: string, run: TestRun) => {
        if (!failed) { failed = true; throw new Error("temporary disk failure"); }
        const current = this.archives.get(run.runId);
        this.archives.set(run.runId, { formatVersion: 1, run: structuredClone(run), nodeRuns: current?.nodeRuns ?? [], events: current?.events ?? [] });
      });
    }
    const logs = new FlakyLogs();
    const { service } = fixture({ logs, canvas: false });
    await service.initialize();
    const blocked = await service.startRun();
    await service.close();

    expect(logs.upsertRun).toHaveBeenCalledTimes(2);
    expect(logs.archives.get(blocked.run.runId)).toEqual(service.exportRun(blocked.run.runId));
    expect(service.listRuns().warnings).toEqual(expect.arrayContaining([expect.stringContaining("retrying") ]));
  });
});

describe("TaskOrchestrationService execution activity", () => {
  it("records a blocked preflight without attempting a hardware lease", async () => {
    const execution = new MemoryExecution();
    const manualLease = execution.acquire({ state: "manual", hardwareId: "HW1", toolName: "write", startedAt: new Date().toISOString() });
    const { service, logs } = fixture({ execution, canvas: false });
    await service.initialize();
    const blocked = await service.startRun();
    expect(blocked.run.status).toBe("blocked");
    expect(execution.activity).toBe("manual");
    expect(logs.archives.size).toBe(1);
    manualLease.release();
    await service.close();
  });

  it("rejects a valid Run when a manual call holds required hardware", async () => {
    const execution = new MemoryExecution();
    const manualLease = execution.acquire({ state: "manual", hardwareId: "HW1", toolName: "write", startedAt: new Date().toISOString() });
    const { service, logs } = fixture({ execution });
    await service.initialize();
    await expect(service.startRun()).rejects.toMatchObject({ category: "conflict" });
    expect(logs.archives.size).toBe(0);
    manualLease.release();
    await service.close();
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

describe("TaskOrchestrationService physical safety", () => {
  it("times out an operator step in cleanup instead of waiting forever", async () => {
    const task: TestTask = {
      ...testTask(),
      steps: [],
      cleanup: [{ stepId: "CLEANUP-OP", label: "Confirm safe state", enabled: true, type: "operator", prompt: "Confirm safe state", options: [{ label: "Done", value: "done" }] }]
    };
    const { service } = fixture({ task, safety: { cleanupBudgetMs: 200, cleanupOperatorTimeoutMs: 20 } });
    await service.initialize();
    const started = await service.startRun();
    await vi.waitFor(() => expect(service.getRun(started.run.runId).run.status).toBe("failed"));
    expect(service.getRun(started.run.runId).nodeRuns.at(-1)).toMatchObject({ nodeId: "CLEANUP-OP", status: "failed", error: { category: "unavailable" } });
    expect(service.listOperatorDecisions()).toEqual([]);
    await service.close();
  });

  it("returns from close within the cleanup budget even when a remote call ignores abort", async () => {
    const cleanupStep = { ...testTask().steps[0]!, stepId: "CLEANUP", label: "Safe stop" };
    const task: TestTask = { ...testTask(), cleanup: [cleanupStep] };
    const callTool = vi.fn(async () => await new Promise<unknown>(() => undefined));
    const { service, execution } = fixture({ task, callTool, safety: { cleanupBudgetMs: 40, cleanupOperatorTimeoutMs: 20 } });
    await service.initialize();
    const started = await service.startRun();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    await expect(Promise.race([
      service.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500))
    ])).resolves.toBe("closed");
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(service.getRun(started.run.runId).run.status).toBe("interrupted");
    expect(execution.activity).toBe("idle");
  });

  it("never retries a non-idempotent tool step", async () => {
    const task = testTask();
    const base = task.steps[0];
    if (base?.type !== "tool") throw new Error("fixture tool step is missing");
    task.steps[0] = { ...base, idempotent: false, retry: { maxAttempts: 3, delayMs: 0, backoff: "fixed", retryOn: ["unavailable"] } };
    const callTool = vi.fn(async () => { throw appError("unavailable", "offline"); });
    const { service } = fixture({ task, callTool });
    await service.initialize();
    const started = await service.startRun();
    await vi.waitFor(() => expect(service.getRun(started.run.runId).run.status).toBe("failed"));
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(service.getRun(started.run.runId).nodeRuns[0]?.attemptErrors).toHaveLength(1);
    await service.close();
  });

  it("retries only selected categories and sends stable idempotency metadata", async () => {
    const task = testTask();
    const base = task.steps[0];
    if (base?.type !== "tool") throw new Error("fixture tool step is missing");
    task.steps[0] = { ...base, idempotent: true, retry: { maxAttempts: 3, delayMs: 0, backoff: "exponential", retryOn: ["unavailable"] } };
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>, _options?: { metadata?: { hardwareId: string; attempt?: number; idempotencyKey?: string } }) => {
      if (callTool.mock.calls.length === 1) throw appError("unavailable", "warming up");
      return { value: 3.3, metadata: args };
    });
    const { service } = fixture({ task, callTool });
    await service.initialize();
    const started = await service.startRun();
    await vi.waitFor(() => expect(service.getRun(started.run.runId).run.status).toBe("passed"));
    expect(callTool).toHaveBeenCalledTimes(2);
    const first = callTool.mock.calls[0]?.[2]?.metadata;
    const second = callTool.mock.calls[1]?.[2]?.metadata;
    expect(callTool.mock.calls[0]?.[1]).toEqual({ value: 3.3 });
    expect(first).toMatchObject({ hardwareId: "HW1", attempt: 1, idempotencyKey: expect.any(String) });
    expect(second).toMatchObject({ hardwareId: "HW1", attempt: 2, idempotencyKey: first?.idempotencyKey });
    expect(service.getRun(started.run.runId).nodeRuns[0]?.attemptErrors).toEqual([expect.objectContaining({ attempt: 1, category: "unavailable", message: "warming up" })]);
    await service.close();
  });

  it("serializes parallel branches that target the same hardware", async () => {
    const base = testTask().steps[0];
    if (base?.type !== "tool") throw new Error("fixture tool step is missing");
    const task: TestTask = {
      ...testTask(),
      steps: [{
        stepId: "PARALLEL", label: "Parallel", enabled: true, type: "parallel",
        branches: [
          { branchId: "A", name: "A", steps: [{ ...base, stepId: "A-TOOL", label: "A" }] },
          { branchId: "B", name: "B", steps: [{ ...base, stepId: "B-TOOL", label: "B" }] }
        ]
      }]
    };
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const callTool = vi.fn(async () => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeCalls -= 1;
      return { value: 3.3 };
    });
    const { service } = fixture({ task, callTool });
    await service.initialize();
    const started = await service.startRun();
    await vi.waitFor(() => expect(service.getRun(started.run.runId).run.status).toBe("passed"));
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(maxActiveCalls).toBe(1);
    await service.close();
  });
});

describe("TaskOrchestrationService crash recovery", () => {
  it("runs compensating cleanup after a crash leaves a non-idempotent tool uncertain", async () => {
    const task = testTask();
    const baseTool = firstTool(task);
    task.steps[0] = { ...baseTool, arguments: { value: { kind: "literal", value: 1 } }, idempotent: false };
    task.cleanup = [{ ...baseTool, stepId: "CLEAN", label: "Safe voltage", arguments: { value: { kind: "literal", value: 0 } }, idempotent: false }];
    const logs = new MemoryRunLogs();
    const firstCalls: number[] = [];
    const first = fixture({
      task,
      logs,
      callTool: async (_name, args) => {
        firstCalls.push(args.value as number);
        return await new Promise<unknown>(() => undefined);
      }
    });
    await first.service.initialize();
    const started = await first.service.startRun();
    await vi.waitFor(() => expect(logs.archives.get(started.run.runId)?.nodeRuns[0]?.status).toBe("running"));
    await vi.waitFor(() => expect(logs.snapshots.has(started.run.runId)).toBe(true));

    const recoveredCalls: number[] = [];
    const second = fixture({ task, logs, callTool: async (_name, args) => { recoveredCalls.push(args.value as number); return { accepted: true }; } });
    await second.service.initialize();
    await vi.waitFor(() => expect(second.service.getRun(started.run.runId).run.status).toBe("interrupted"));
    const detail = second.service.getRun(started.run.runId);

    expect(firstCalls).toEqual([1]);
    expect(recoveredCalls).toEqual([0]);
    expect(detail.nodeRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "STEP1", status: "cancelled" }),
      expect.objectContaining({ nodeId: "CLEAN", status: "passed" })
    ]));
    expect(detail.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.recovery_cleanup_started", "run.interrupted"]));
    await second.service.close();
  });

  it("resumes an idempotent orphan from the last confirmed node with a stable key", async () => {
    const task = testTask();
    const baseTool = firstTool(task);
    task.steps = [
      { ...baseTool, stepId: "FIRST", label: "First", arguments: { value: { kind: "literal", value: 1 } }, idempotent: true },
      { ...baseTool, stepId: "SECOND", label: "Second", arguments: { value: { kind: "literal", value: 2 } }, idempotent: true }
    ];
    const logs = new MemoryRunLogs();
    const firstCalls: { value: number; key: string }[] = [];
    const first = fixture({
      task,
      logs,
      callTool: async (_name, args, options) => {
        firstCalls.push({ value: args.value as number, key: options?.metadata?.idempotencyKey ?? "" });
        if (args.value === 2) return await new Promise<unknown>(() => undefined);
        return { accepted: true };
      }
    });
    await first.service.initialize();
    const started = await first.service.startRun();
    await vi.waitFor(() => expect(logs.archives.get(started.run.runId)?.nodeRuns.some((nodeRun) => nodeRun.nodeId === "SECOND" && nodeRun.status === "running")).toBe(true));

    const recoveredCalls: { value: number; key: string }[] = [];
    const second = fixture({
      task,
      logs,
      callTool: async (_name, args, options) => {
        recoveredCalls.push({ value: args.value as number, key: options?.metadata?.idempotencyKey ?? "" });
        return { accepted: true };
      }
    });
    await second.service.initialize();
    await vi.waitFor(() => expect(second.service.getRun(started.run.runId).run.status).toBe("passed"));
    const detail = second.service.getRun(started.run.runId);

    expect(firstCalls.map((call) => call.value)).toEqual([1, 2]);
    expect(recoveredCalls.map((call) => call.value)).toEqual([2]);
    expect(recoveredCalls[0]!.key).toBe(firstCalls[1]!.key);
    expect(detail.events.map((event) => event.type)).toContain("run.recovery_resumed");
    await second.service.close();
  });

  it("records disabled steps as skipped nodes", async () => {
    const task = testTask();
    task.steps.unshift({ stepId: "DISABLED", label: "Disabled delay", enabled: false, type: "delay", durationMs: { kind: "literal", value: 1 } });
    const { service } = fixture({ task });
    await service.initialize();
    const started = await service.startRun();
    await vi.waitFor(() => expect(service.getRun(started.run.runId).run.status).toBe("passed"));
    expect(service.getRun(started.run.runId).nodeRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "DISABLED", status: "skipped" })
    ]));
    await service.close();
  });
});
