import { vi } from "vitest";
import type {
  TestBatch, TestItemStatus, TestPlan, TestRunSnapshot, TestRunSummary
} from "@hardwareharness/contracts/testing";

/** Test-only fake of `window.hardwareharness` for the 功能测试 page tests. */

export const startedAt = "2026-09-17T00:00:00.000Z";

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

export function makeBatch(planIds: string[], stopOnFail: boolean): TestBatch {
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
    loadPlan: vi.fn(async (planId: string) => structuredClone(byId.get(planId) ?? first)),
    savePlan: vi.fn(async (value: TestPlan) => ({
      plan: { ...structuredClone(value), revision: value.revision + 1 }, issues: []
    })),
    createPlan: vi.fn(),
    deletePlan: vi.fn(),
    applyPlanOperations: vi.fn(),
    validatePlan: vi.fn(async (planId: string) => ({
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
    currentRun: vi.fn(async () => null),
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
    startUnit: vi.fn(),
    reorderItems: vi.fn(),
    startBatch: vi.fn(async (input: { planIds: string[]; stopOnFail: boolean }) => {
      batch = makeBatch(input.planIds, input.stopOnFail);
      return batch;
    }),
    abortBatch: vi.fn(),
    currentBatch: vi.fn(async () => null),
    getBatch: vi.fn(),
    listRecoveryItems: vi.fn(async () => []),
    reconcileOperation: vi.fn()
  };
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: {
      system: {
        dashboard: vi.fn(async () => ({
          computers: [], statuses: [], servers: [], serverStatuses: [], hardware: [], tools: [],
          gateway: {}, execution: {}
        })),
        exportText: vi.fn()
      },
      devices: { listHardware: vi.fn(async () => []), hardwareImageUrl: vi.fn(() => "") },
      testing,
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
