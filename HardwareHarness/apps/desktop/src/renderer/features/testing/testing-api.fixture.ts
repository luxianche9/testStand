import { vi } from "vitest";
import type { RunMessages } from "@hardwareharness/contracts/observability";
import type {
  IcdCheck, IcdDocument, IcdSummary, TestBatch, TestItemStatus, TestPlan, TestRunSnapshot, TestRunSummary
} from "@hardwareharness/contracts/testing";

/** Test-only fake of `window.hardwareharness` for the 功能测试 page tests. */

const startedAt = "2026-09-17T00:00:00.000Z";

export function makePlan(id = "plan", name = "台架冒烟测试"): TestPlan {
  return {
    schemaVersion: 2,
    id,
    name,
    description: "",
    revision: 1,
    parameters: [],
    requirements: [],
    stopOnFail: false,
    regions: { prepare: [], test: [], cleanup: [] },
    createdAt: startedAt,
    updatedAt: startedAt
  };
}

export function makeItem(planId: string, name: string, extra: Partial<TestItemStatus> = {}): TestItemStatus {
  return { planId, name, revision: 1, invalid: false, queued: false, stale: false, ...extra };
}

export function makeRun(plan: TestPlan, extra: Partial<TestRunSnapshot> = {}): TestRunSnapshot {
  return {
    runId: "run",
    planId: plan.id,
    revision: 1,
    planName: plan.name,
    state: "running",
    verdict: "NotSet",
    executionStatus: "Running",
    cleanupStatus: "NotRequired",
    safetyStatus: "NotRequired",
    outcomeKnown: true,
    recoveryRequired: false,
    coverage: { requirements: [], total: 0 },
    operations: [],
    startedAt,
    sequence: 1,
    resultSequence: 0,
    pauseRequested: false,
    abortRequested: false,
    hardwareIds: [],
    ...extra
  };
}

export function makeSummary(runId: string, planName: string, at: string): TestRunSummary {
  return {
    runId,
    planId: "plan",
    planName,
    revision: 1,
    state: "completed",
    verdict: "Pass",
    executionStatus: "Succeeded",
    cleanupStatus: "Succeeded",
    safetyStatus: "Verified",
    outcomeKnown: true,
    recoveryRequired: false,
    startedAt: at
  };
}

function makeBatch(planIds: string[], stopOnFail: boolean): TestBatch {
  return {
    batchId: "batch",
    state: "running",
    stopOnFail,
    unitId: "unit",
    startedAt,
    ...(planIds[0] ? { currentPlanId: planIds[0] } : {}),
    items: planIds.map((planId) => ({ planId, planName: planId, state: "queued" as const }))
  };
}

export type Subscriber = (payload: unknown) => void;

/** Installs the fake API; returns the testing mocks and the last subscriber per event name. */
export function installTestingApi(plans: TestPlan[], items: TestItemStatus[]) {
  const subscribers = new Map<string, Subscriber>();
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const first = plans[0] ?? makePlan();
  let batch: TestBatch | undefined;
  const testing = {
    listPlans: vi.fn(async () => plans.map((plan) => ({
      id: plan.id, name: plan.name, revision: plan.revision, stepCount: 0
    }))),
    loadPlan: vi.fn(async ({ planId }: { planId: string }) => structuredClone(byId.get(planId) ?? first)),
    savePlan: vi.fn(async ({ plan }: { plan: TestPlan; baseRevision?: number }) => ({
      plan: { ...structuredClone(plan), revision: plan.revision + 1 }, issues: []
    })),
    createPlan: vi.fn(),
    deletePlan: vi.fn(),
    applyPlanOperations: vi.fn(),
    validatePlan: vi.fn(async ({ planId }: { planId: string }) => ({
      planId, revision: 1, valid: true, issues: [], executionRevision: "exec", wiringRevision: "wiring",
      coverage: { requirements: [], total: 0 }
    })),
    analyzePlanDraft: vi.fn(async () => ({ issues: [], referencesByStepId: {} })),
    listStepCatalog: vi.fn(async () => [{
      type: "Delay", category: "数据", label: "延时", settingsSchema: {}, outputSchema: {}, container: false
    }]),
    listDeviceTools: vi.fn(async () => ({ hardwareId: "device", tools: [], issues: [] })),
    startRun: vi.fn(async () => makeRun(first)),
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    abortRun: vi.fn(),
    currentRun: vi.fn(async (): Promise<TestRunSnapshot | null> => null),
    getRun: vi.fn(),
    listRuns: vi.fn(async (): Promise<{ items: TestRunSummary[]; nextCursor?: string }> => ({ items: [] })),
    readRunLog: vi.fn(async () => ({
      run: makeRun(first), plan: structuredClone(first), events: [], results: [],
      nextEventSequence: 1, nextResultSequence: 0, latestEventSequence: 1, latestResultSequence: 0,
      hasMoreEvents: false, hasMoreResults: false
    })),
    readRunResults: vi.fn(),
    listItemStatus: vi.fn(async () => ({
      unit: { unitId: "unit", serialNumber: "SN-0001", startedAt }, items: structuredClone(items),
      ...(batch ? { batch } : {})
    })),
    currentUnit: vi.fn(),
    reorderItems: vi.fn(),
    startBatch: vi.fn(async ({ input }: { input: { planIds: string[]; stopOnFail: boolean } }) => {
      batch = makeBatch(input.planIds, input.stopOnFail);
      return batch;
    }),
    abortBatch: vi.fn(),
    currentBatch: vi.fn(async () => null),
    getBatch: vi.fn(),
    listRecoveryItems: vi.fn(async () => []),
    reconcileOperation: vi.fn(),
    listRunStreams: vi.fn(async ({ runId }: { runId: string }) => ({ runId, recording: false, streams: [] })),
    readRunStream: vi.fn(async () => ({ mode: "records", records: [], next: null, recording: false })),
    getRunTimeline: vi.fn(async ({ runId }: { runId: string }) => ({
      runId, tb0: null, tb1: null, steps: [], calls: [], anchors: [], windows: [], violations: [], marks: [],
      streams: [], gaps: []
    })),
    readRunIo: vi.fn(),
    readRunMessages: vi.fn(async ({ runId }: { runId: string }): Promise<RunMessages> => ({
      runId, bindings: [], messages: [], total: 0, truncated: false
    })),
    listIcds: vi.fn(async (): Promise<IcdSummary[]> => []),
    readIcd: vi.fn(async ({ name }: { name: string }): Promise<IcdDocument> => ({ name, text: "", valid: false })),
    checkIcd: vi.fn(async (): Promise<IcdCheck> => ({ valid: false })),
    saveIcd: vi.fn(async ({ input }: { input: { name: string; text: string } }) => ({
      name: input.name,
      icd: { name: input.name, icdHash: "h", transport: "bytes" as const, messages: [], encoders: [], streams: [] }
    })),
    rejudgeRun: vi.fn(async ({ runId }: { runId: string }) => ({ runId, results: [], consistent: true })),
    answerManualCheck: vi.fn(async ({ input }: { input: { runId: string } }) => makeRun(first, { runId: input.runId }))
  };
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: {
      system: {
        dashboard: vi.fn(async () => ({
          devices: [], deviceStatuses: [], hardware: [], tools: [],
          gateway: {}, execution: {}
        }))
      },
      dialogs: { exportText: vi.fn() },
      devices: { listHardware: vi.fn(async () => []) },
      testing,
      streams: {
        live: vi.fn(() => () => undefined),
        window: vi.fn(async ({ runId, t0, t1 }: { runId: string; t0: number; t1: number }) => ({
          runId, t0, t1, colMs: 1, recording: false, streams: {}
        }))
      },
      events: {
        subscribe: vi.fn((name: string, callback: Subscriber) => {
          subscribers.set(name, callback);
          return () => subscribers.delete(name);
        })
      }
    }
  });
  vi.stubGlobal("crypto", { randomUUID: () => "request-id" });
  return { testing, subscribers };
}
