import type {
  OperatorDecision,
  TestNodeRun,
  TestRun,
  TestRunDetail,
  TestRunEvent,
  TestRunListQuery,
  TestRunListResult,
  TestRunLogArchive
} from "@testforge/contracts/orchestration";
import { testRunListQuerySchema } from "@testforge/contracts/orchestration";

export type RunStoreMutation =
  | { type: "run"; run: TestRun }
  | { type: "nodeRun"; nodeRun: TestNodeRun }
  | { type: "events"; runId: string; events: TestRunEvent[] };

export class RunStore {
  private readonly runs = new Map<string, TestRun>();
  private readonly nodeRuns = new Map<string, TestNodeRun>();
  private readonly nodeOrder = new Map<string, string[]>();
  private readonly events = new Map<string, TestRunEvent[]>();
  private readonly nextEventIds = new Map<string, number>();
  private warnings: string[] = [];

  constructor(
    private readonly onMutation: (mutation: RunStoreMutation) => void = () => undefined,
    private readonly boundValue: (value: unknown) => unknown = (value) => value
  ) {}

  clear(): void {
    this.runs.clear();
    this.nodeRuns.clear();
    this.nodeOrder.clear();
    this.events.clear();
    this.nextEventIds.clear();
    this.warnings = [];
  }

  setWarnings(warnings: string[]): void { this.warnings = [...warnings]; }

  addWarning(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  allRuns(): TestRun[] { return [...this.runs.values()].map((run) => structuredClone(run)); }

  insertRun(run: TestRun): void {
    this.runs.set(run.runId, structuredClone(run));
    this.nodeOrder.set(run.runId, []);
    this.events.set(run.runId, []);
    this.nextEventIds.set(run.runId, 1);
    this.onMutation({ type: "run", run: structuredClone(run) });
  }

  updateRun(run: TestRun): void {
    this.runs.set(run.runId, structuredClone(run));
    this.onMutation({ type: "run", run: structuredClone(run) });
  }

  getRunRecord(runId: string): TestRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown runId: ${runId}`);
    return structuredClone(run);
  }

  hasRun(runId: string): boolean { return this.runs.has(runId); }

  getRun(runId: string, sinceEventId = 0, nodeOffset = 0, nodeLimit = 200): TestRunDetail {
    const order = this.nodeOrder.get(runId) ?? [];
    return {
      run: this.getRunRecord(runId),
      nodeRuns: this.listNodeRuns(runId, nodeOffset, nodeLimit),
      events: this.listEvents(runId, sinceEventId),
      nodeTotal: order.length
    };
  }

  listRuns(raw: TestRunListQuery = {}): TestRunListResult {
    const query = testRunListQuerySchema.parse(raw);
    const statuses = query.statuses?.length ? new Set(query.statuses) : undefined;
    const search = query.search?.trim().toLocaleLowerCase();
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    const filtered = [...this.runs.values()]
      .filter((run) => !statuses || statuses.has(run.status))
      .filter((run) => from === undefined || Date.parse(run.createdAt) >= from)
      .filter((run) => to === undefined || Date.parse(run.createdAt) <= to)
      .filter((run) => !search || [run.runId, run.taskName, run.summary?.message ?? ""].some((value) => value.toLocaleLowerCase().includes(search)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId));
    return {
      items: filtered.slice(query.offset, query.offset + query.limit).map((run) => structuredClone(run)),
      total: filtered.length,
      warnings: [...this.warnings]
    };
  }

  insertNodeRun(nodeRun: TestNodeRun): void {
    this.nodeRuns.set(nodeRun.nodeRunId, structuredClone(nodeRun));
    const order = this.nodeOrder.get(nodeRun.runId) ?? [];
    order.push(nodeRun.nodeRunId);
    this.nodeOrder.set(nodeRun.runId, order);
    this.onMutation({ type: "nodeRun", nodeRun: structuredClone(nodeRun) });
  }

  saveNodeRun(nodeRun: TestNodeRun): void {
    this.nodeRuns.set(nodeRun.nodeRunId, structuredClone(nodeRun));
    this.onMutation({ type: "nodeRun", nodeRun: structuredClone(nodeRun) });
  }

  getNodeRun(nodeRunId: string): TestNodeRun {
    const node = this.nodeRuns.get(nodeRunId);
    if (!node) throw new Error(`Unknown nodeRunId: ${nodeRunId}`);
    return structuredClone(node);
  }

  listNodeRunsForRun(runId: string): TestNodeRun[] {
    return (this.nodeOrder.get(runId) ?? []).map((nodeRunId) => structuredClone(this.nodeRuns.get(nodeRunId)!));
  }

  findPassedNode(runId: string, nodeId: string, branchPath: string, iterationPath: number[]): TestNodeRun | undefined {
    return this.listNodeRunsForRun(runId).find((nodeRun) =>
      nodeRun.nodeId === nodeId
      && nodeRun.branchPath === branchPath
      && nodeRun.status === "passed"
      && sameNumbers(nodeRun.iterationPath, iterationPath));
  }

  listOperatorDecisions(): OperatorDecision[] {
    return [...this.nodeRuns.values()]
      .filter((node) => node.status === "waiting_operator" && node.decision)
      .sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""))
      .map((node) => ({
        nodeRunId: node.nodeRunId,
        runId: node.runId,
        nodeId: node.nodeId,
        prompt: node.decision!.prompt,
        options: structuredClone(node.decision!.options)
      }));
  }

  addEvent(runId: string, type: string, data?: unknown): TestRunEvent {
    const event: TestRunEvent = {
      eventId: this.nextEventIds.get(runId) ?? 1,
      runId,
      timestamp: new Date().toISOString(),
      type,
      ...(data === undefined ? {} : { data: this.boundValue(data) })
    };
    this.nextEventIds.set(runId, event.eventId + 1);
    const list = this.events.get(runId) ?? [];
    list.push(structuredClone(event));
    this.events.set(runId, list);
    this.onMutation({ type: "events", runId, events: [structuredClone(event)] });
    return structuredClone(event);
  }

  summary(runId: string, message?: string): NonNullable<TestRun["summary"]> {
    const nodes = (this.nodeOrder.get(runId) ?? []).map((nodeRunId) => this.nodeRuns.get(nodeRunId)!).filter(Boolean);
    return {
      passedNodes: nodes.filter((item) => item.status === "passed").length,
      failedNodes: nodes.filter((item) => item.status === "failed").length,
      cancelledNodes: nodes.filter((item) => item.status === "cancelled").length,
      ...(message ? { message } : {})
    };
  }

  loadArchive(archive: TestRunLogArchive): void {
    const runId = archive.run.runId;
    if (this.runs.has(runId)) {
      this.addWarning(`${runId}: duplicate Run archive`);
      return;
    }
    this.runs.set(runId, structuredClone(archive.run));
    const order: string[] = [];
    for (const node of archive.nodeRuns) {
      if (this.nodeRuns.has(node.nodeRunId)) {
        this.addWarning(`${runId}: duplicate nodeRunId ${node.nodeRunId}`);
        continue;
      }
      this.nodeRuns.set(node.nodeRunId, structuredClone(node));
      order.push(node.nodeRunId);
    }
    this.nodeOrder.set(runId, order);
    const events = archive.events.map((event) => structuredClone(event)).sort((left, right) => left.eventId - right.eventId);
    this.events.set(runId, events);
    this.nextEventIds.set(runId, Math.max(0, ...events.map((event) => event.eventId)) + 1);
  }

  archive(runId: string): TestRunLogArchive {
    const run = this.getRunRecord(runId);
    const nodeRuns = (this.nodeOrder.get(runId) ?? []).map((nodeRunId) => structuredClone(this.nodeRuns.get(nodeRunId)!));
    const events = (this.events.get(runId) ?? []).map((event) => structuredClone(event));
    return { formatVersion: 1, run, nodeRuns, events };
  }

  removeRun(runId: string): void {
    for (const nodeRunId of this.nodeOrder.get(runId) ?? []) this.nodeRuns.delete(nodeRunId);
    this.nodeOrder.delete(runId);
    this.events.delete(runId);
    this.nextEventIds.delete(runId);
    this.runs.delete(runId);
  }

  private listNodeRuns(runId: string, offset: number, limit: number): TestNodeRun[] {
    const order = this.nodeOrder.get(runId) ?? [];
    return order.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.min(Math.max(limit, 1), 500))
      .map((id) => structuredClone(this.nodeRuns.get(id)!));
  }

  private listEvents(runId: string, sinceEventId: number): TestRunEvent[] {
    return (this.events.get(runId) ?? [])
      .filter((event) => event.eventId > sinceEventId)
      .map((event) => structuredClone(event));
  }
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
