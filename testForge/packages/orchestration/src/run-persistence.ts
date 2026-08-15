import type { TestNodeRun, TestRun, TestRunEvent, TestRunExecutionSnapshot, TestRunLogArchive } from "@testforge/contracts/orchestration";
import type { OrchestrationRunLogPort } from "./orchestration-ports.js";
import type { RunStoreMutation } from "./run-store.js";

type PendingRun = {
  run: TestRun | undefined;
  nodeRuns: Map<string, TestNodeRun>;
  events: TestRunEvent[];
  snapshot: TestRunExecutionSnapshot | undefined;
};

export class RunPersistence {
  private readonly pending = new Map<string, PendingRun>();
  private worker: Promise<void> | undefined;
  private retryAttempt = 0;

  constructor(
    private readonly runLogs: OrchestrationRunLogPort,
    private readonly session: () => { rootPath: string } | undefined,
    private readonly addWarning: (message: string) => void
  ) {}

  enqueue(mutation: RunStoreMutation): void {
    const runId = mutation.type === "run" ? mutation.run.runId : mutation.type === "nodeRun" ? mutation.nodeRun.runId : mutation.runId;
    const pending = this.pending.get(runId) ?? emptyPendingRun();
    if (mutation.type === "run") pending.run = structuredClone(mutation.run);
    else if (mutation.type === "nodeRun") pending.nodeRuns.set(mutation.nodeRun.nodeRunId, structuredClone(mutation.nodeRun));
    else pending.events.push(...mutation.events.map((event) => structuredClone(event)));
    this.pending.set(runId, pending);
    this.startWorker();
  }

  async load(rootPath: string): Promise<{ archives: TestRunLogArchive[]; snapshots: TestRunExecutionSnapshot[]; warnings: string[] }> {
    return await this.runLogs.load(rootPath);
  }

  enqueueSnapshot(snapshot: TestRunExecutionSnapshot): void {
    const pending = this.pending.get(snapshot.runId) ?? emptyPendingRun();
    pending.snapshot = structuredClone(snapshot);
    this.pending.set(snapshot.runId, pending);
    this.startWorker();
  }

  async remove(rootPath: string, runId: string): Promise<void> {
    await this.flush();
    await this.runLogs.remove(rootPath, runId);
    this.pending.delete(runId);
  }

  async clearRuns(rootPath: string, runIds: string[]): Promise<void> {
    await this.flush();
    await this.runLogs.clear(rootPath, runIds);
    for (const runId of runIds) this.pending.delete(runId);
  }

  clear(): void {
    this.pending.clear();
    this.worker = undefined;
    this.retryAttempt = 0;
  }

  async flush(): Promise<void> {
    this.startWorker();
    while (this.worker) await this.worker;
  }

  private startWorker(): void {
    if (this.worker || this.pending.size === 0) return;
    const operation = this.persistPending();
    let wrapped!: Promise<void>;
    wrapped = operation.finally(() => {
      if (this.worker === wrapped) this.worker = undefined;
      if (this.pending.size > 0) this.startWorker();
    });
    this.worker = wrapped;
  }

  private async persistPending(): Promise<void> {
    while (this.pending.size > 0) {
      const entry = this.pending.entries().next().value as [string, PendingRun];
      const [runId, batch] = entry;
      this.pending.delete(runId);
      const session = this.session();
      if (!session) continue;
      try {
        if (batch.run) await this.runLogs.upsertRun(session.rootPath, batch.run);
        for (const nodeRun of batch.nodeRuns.values()) await this.runLogs.upsertNodeRun(session.rootPath, nodeRun);
        if (batch.events.length > 0) await this.runLogs.appendEvents(session.rootPath, runId, batch.events);
        if (batch.snapshot) await this.runLogs.upsertExecutionSnapshot(session.rootPath, batch.snapshot);
        this.retryAttempt = 0;
      } catch (error) {
        this.mergeFailedBatch(runId, batch);
        this.retryAttempt += 1;
        const delayMs = Math.min(2_000, 25 * 2 ** Math.min(this.retryAttempt - 1, 6));
        this.addWarning(`${runId}: failed to persist Run log; retrying in ${delayMs} ms: ${errorMessage(error)}`);
        await delay(delayMs);
      }
    }
  }

  private mergeFailedBatch(runId: string, failed: PendingRun): void {
    const current = this.pending.get(runId);
    if (!current) {
      this.pending.set(runId, failed);
      return;
    }
    const nodes = new Map(failed.nodeRuns);
    for (const [nodeRunId, nodeRun] of current.nodeRuns) nodes.set(nodeRunId, nodeRun);
    this.pending.set(runId, {
      run: current.run ?? failed.run,
      nodeRuns: nodes,
      events: [...failed.events, ...current.events],
      snapshot: current.snapshot ?? failed.snapshot
    });
  }
}

function emptyPendingRun(): PendingRun {
  return { run: undefined, nodeRuns: new Map(), events: [], snapshot: undefined };
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
