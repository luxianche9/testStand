// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestPlan } from "@hardwareharness/contracts/testing";
import { TestPlanPage } from "./TestPlanPage.js";

const plan: TestPlan = {
  schemaVersion: 2,
  id: "plan",
  name: "台架冒烟测试",
  description: "",
  revision: 1,
  parameters: [],
  requirements: [],
  wiringRequirements: [],
  stopOnFail: false,
  regions: { prepare: [], test: [], cleanup: [] },
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z"
};

const loadPlan = vi.fn();
const savePlan = vi.fn();
const validatePlan = vi.fn();
const startRun = vi.fn();
const listRuns = vi.fn();
const subscribers = new Map<string, (payload: unknown) => void>();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  loadPlan.mockResolvedValue(structuredClone(plan));
  savePlan.mockImplementation(async (value: TestPlan) => ({ plan: { ...structuredClone(value), revision: value.revision + 1 }, issues: [] }));
  validatePlan.mockResolvedValue({ planId: "plan", revision: 1, valid: true, issues: [], executionRevision: "exec", wiringRevision: "wiring", coverage: { requirements: [], total: 0 } });
  startRun.mockResolvedValue({ runId: "run", planId: "plan", revision: 1, planName: plan.name, state: "running", verdict: "NotSet", executionStatus: "Running", cleanupStatus: "NotRequired", safetyStatus: "NotRequired", outcomeKnown: true, recoveryRequired: false, coverage: { requirements: [], total: 0 }, operations: [], startedAt: plan.createdAt, sequence: 1, resultSequence: 0, pauseRequested: false, abortRequested: false, hardwareIds: [] });
  listRuns.mockResolvedValue({ items: [] });
  subscribers.clear();
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: {
      system: { dashboard: vi.fn(async () => ({ computers: [], statuses: [], servers: [], serverStatuses: [], hardware: [], tools: [], gateway: {}, execution: {} })) },
      devices: { listHardware: vi.fn(async () => []) },
      testing: {
        listPlans: vi.fn(async () => [{ id: "plan", name: plan.name, revision: 1, stepCount: 0 }]),
        loadPlan,
        savePlan,
        createPlan: vi.fn(),
        deletePlan: vi.fn(),
        applyPlanOperations: vi.fn(),
        validatePlan,
        analyzePlanDraft: vi.fn(async () => ({ issues: [], referencesByStepId: {} })),
        listStepCatalog: vi.fn(async () => [{ type: "Delay", category: "数据", label: "延时", settingsSchema: {}, outputSchema: {}, container: false }]),
        listDeviceTools: vi.fn(async () => ({ hardwareId: "device", tools: [], issues: [] })),
        startRun,
        pauseRun: vi.fn(),
        resumeRun: vi.fn(),
        abortRun: vi.fn(),
        currentRun: vi.fn(async () => null),
        getRun: vi.fn(),
        listRuns,
        readRunLog: vi.fn(async () => ({ run: { runId: "run", planId: "plan", revision: 1, planName: plan.name, state: "running", verdict: "NotSet", executionStatus: "Running", safetyStatus: "NotRequired", startedAt: plan.createdAt, sequence: 1, resultSequence: 0, pauseRequested: false, abortRequested: false, hardwareIds: [], cleanupStatus: "NotRequired", outcomeKnown: true, recoveryRequired: false, coverage: { requirements: [], total: 0 }, operations: [] }, plan: structuredClone(plan), events: [], results: [], nextEventSequence: 1, nextResultSequence: 0, latestEventSequence: 1, latestResultSequence: 0, hasMoreEvents: false, hasMoreResults: false })),
        readRunResults: vi.fn()
      },
      events: {
        subscribe: vi.fn((name: string, callback: (payload: unknown) => void) => {
          subscribers.set(name, callback);
          return () => subscribers.delete(name);
        })
      }
    }
  });
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("crypto", { randomUUID: () => "request-id" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("TestPlanPage", () => {
  it("adds a catalog step once, saves, validates and starts the saved revision", async () => {
    render(<TestPlanPage />, { wrapper: Wrapper });
    await screen.findByDisplayValue(plan.name);
    await userEvent.click(screen.getByRole("button", { name: "组件库" }));
    await userEvent.click(screen.getByRole("button", { name: /延时/ }));
    expect(screen.getAllByLabelText("删除步骤")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(savePlan).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "校验" }));
    await waitFor(() => expect(validatePlan).toHaveBeenCalledWith("plan"));
    await userEvent.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan", revision: 1, executionRevision: "exec", requestId: "request-id", parameters: {} })));
  });

  it("protects a dirty draft when an AI plan revision arrives", async () => {
    render(<TestPlanPage />, { wrapper: Wrapper });
    const name = await screen.findByDisplayValue(plan.name);
    await userEvent.type(name, " 本地修改");
    await act(async () => subscribers.get("testPlan")?.({ planId: "plan", revision: 2 }));
    expect(await screen.findByText(/AI 或磁盘已修改当前计划/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /保存/ }).hasAttribute("disabled")).toBe(true);
  });

  it("appends and deduplicates run history pages", async () => {
    const summary = (runId: string, startedAt: string) => ({ runId, planId: "plan", planName: `${plan.name} ${runId}`, revision: 1, state: "completed" as const, verdict: "Pass" as const, executionStatus: "Succeeded" as const, cleanupStatus: "Succeeded" as const, safetyStatus: "Verified" as const, outcomeKnown: true, recoveryRequired: false, startedAt });
    listRuns.mockImplementation(async (input: { cursor?: string }) => input.cursor ? { items: [summary("run-1", "2026-09-18T00:00:00Z"), summary("run-2", "2026-09-17T00:00:00Z")] } : { items: [summary("run-1", "2026-09-18T00:00:00Z")], nextCursor: "page-2" });
    render(<TestPlanPage />, { wrapper: Wrapper });
    await screen.findByDisplayValue(plan.name);
    await userEvent.click(screen.getByRole("button", { name: "运行日志" }));
    expect(await screen.findByText(`${plan.name} run-1`)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText(`${plan.name} run-2`)).toBeTruthy();
    expect(screen.getAllByText(`${plan.name} run-1`)).toHaveLength(1);
  });
});
