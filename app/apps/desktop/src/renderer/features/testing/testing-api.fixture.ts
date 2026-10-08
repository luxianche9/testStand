import { vi } from "vitest";
import type { RunMessages } from "@teststand/contracts/observability";
import type {
  IcdCheck, IcdDocument, IcdSummary, TestPlan, TestRunSnapshot, TestRunSummary
} from "@teststand/contracts/testing";

/** Test-only fake of `window.teststand` for the 测试 panel tests. */

const startedAt = "2026-09-17T00:00:00.000Z";

export function makePlan(id = "flow", name = "台架冒烟测试"): TestPlan {
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
    planId: "flow",
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

export type Subscriber = (payload: unknown) => void;

/** Installs the fake API; returns the testing mocks and the last subscriber per event name. */
export function installTestingApi(plans: TestPlan[]) {
  const subscribers = new Map<string, Subscriber>();
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const first = plans[0] ?? makePlan();
  const testing = {
    loadPlan: vi.fn(async ({ planId }: { planId: string }) => structuredClone(byId.get(planId) ?? first)),
    savePlan: vi.fn(async ({ plan }: { plan: TestPlan; baseRevision?: number }) => ({
      plan: { ...structuredClone(plan), revision: plan.revision + 1 }, issues: []
    })),
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
    currentUnit: vi.fn(),
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
  Object.defineProperty(window, "teststand", {
    configurable: true,
    value: {
      system: {
        dashboard: vi.fn(async () => ({
          devices: [], deviceStatuses: [], hardware: [], tools: [],
          gateway: {}, execution: {}
        }))
      },
      dialogs: { exportText: vi.fn() },
      projects: { document: vi.fn(async () => ({ rootPath: "C:/bench" })) },
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
