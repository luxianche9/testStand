import type { Hardware, ToolCatalogItem } from "@testforge/contracts/devices";
import type { ActiveExecutionActivity } from "@testforge/contracts/execution";
import type { TestNodeRun, TestRun, TestRunEvent, TestRunExecutionSnapshot, TestRunLogArchive, TestTask } from "@testforge/contracts/orchestration";
import type { ProjectDocument } from "@testforge/contracts/projects";
import type { ProjectWiring } from "@testforge/contracts/wiring";

export interface OrchestrationSafetyOptions {
  cleanupBudgetMs?: number;
  cleanupOperatorTimeoutMs?: number;
}

export interface OrchestrationProjectPort {
  task(): TestTask;
  wiring(): ProjectWiring;
  updateTask(task: TestTask): ProjectDocument;
  projectId(): string;
  session(): { projectId: string; rootPath: string } | undefined;
}

export interface OrchestrationToolPort {
  listTools(): ToolCatalogItem[];
  isHardwareOccupied(hardwareId: string): boolean;
  callTool(name: string, args: Record<string, unknown>, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    metadata?: { hardwareId: string; attempt?: number; idempotencyKey?: string };
  }): Promise<unknown>;
}

export interface OrchestrationCatalogPort {
  getHardware(hardwareId: string): Hardware;
}

export interface OrchestrationExecutionLease { release(): void }

export interface OrchestrationExecutionPort {
  acquire(activity: ActiveExecutionActivity): OrchestrationExecutionLease;
}

export interface OrchestrationRunLogPort {
  load(rootPath: string): Promise<{ archives: TestRunLogArchive[]; snapshots: TestRunExecutionSnapshot[]; warnings: string[] }>;
  upsertRun(rootPath: string, run: TestRun): Promise<void>;
  upsertNodeRun(rootPath: string, nodeRun: TestNodeRun): Promise<void>;
  appendEvents(rootPath: string, runId: string, events: TestRunEvent[]): Promise<void>;
  upsertExecutionSnapshot(rootPath: string, snapshot: TestRunExecutionSnapshot): Promise<void>;
  remove(rootPath: string, runId: string): Promise<void>;
  clear(rootPath: string, runIds: string[]): Promise<void>;
}

export const NOOP_EXECUTION: OrchestrationExecutionPort = {
  acquire: () => ({ release: () => undefined })
};

export const NOOP_RUN_LOGS: OrchestrationRunLogPort = {
  load: async () => ({ archives: [], snapshots: [], warnings: [] }),
  upsertRun: async () => undefined,
  upsertNodeRun: async () => undefined,
  appendEvents: async () => undefined,
  upsertExecutionSnapshot: async () => undefined,
  remove: async () => undefined,
  clear: async () => undefined
};
