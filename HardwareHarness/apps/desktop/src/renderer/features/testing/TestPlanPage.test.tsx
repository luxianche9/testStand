// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestPlan } from "@hardwareharness/contracts/testing";
import { TestPlanPage } from "./TestPlanPage.js";

const plan: TestPlan = {
  schemaVersion: 1,
  id: "plan",
  name: "台架冒烟测试",
  description: "",
  revision: 1,
  parameters: [],
  stopOnFail: false,
  regions: { prepare: [], test: [], cleanup: [] },
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z"
};

const loadPlan = vi.fn();
const savePlan = vi.fn();
const validatePlan = vi.fn();
const startRun = vi.fn();
const subscribers = new Map<string, (payload: unknown) => void>();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  loadPlan.mockResolvedValue(structuredClone(plan));
  savePlan.mockImplementation(async (value: TestPlan) => ({ plan: { ...structuredClone(value), revision: value.revision + 1 }, issues: [] }));
  validatePlan.mockResolvedValue({ planId: "plan", revision: 1, valid: true, issues: [] });
  startRun.mockResolvedValue({ runId: "run", planId: "plan", revision: 1, planName: plan.name, state: "running", verdict: "NotSet", startedAt: plan.createdAt, sequence: 1, resultSequence: 0, pauseRequested: false, abortRequested: false, hardwareIds: [] });
  subscribers.clear();
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: {
      devices: { listHardware: vi.fn(async () => []) },
      testing: {
        listPlans: vi.fn(async () => [{ id: "plan", name: plan.name, revision: 1, stepCount: 0 }]),
        loadPlan,
        savePlan,
        createPlan: vi.fn(),
        deletePlan: vi.fn(),
        applyPlanOperations: vi.fn(),
        validatePlan,
        listStepCatalog: vi.fn(async () => [{ type: "Delay", category: "数据", label: "延时", settingsSchema: {}, outputSchema: {}, container: false }]),
        listDeviceTools: vi.fn(async () => ({ hardwareId: "device", tools: [], issues: [] })),
        startRun,
        pauseRun: vi.fn(),
        resumeRun: vi.fn(),
        abortRun: vi.fn(),
        currentRun: vi.fn(async () => null),
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
    await userEvent.click(screen.getByRole("button", { name: "延时" }));
    expect(screen.getAllByLabelText("删除步骤")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(savePlan).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "校验" }));
    await waitFor(() => expect(validatePlan).toHaveBeenCalledWith("plan"));
    await userEvent.click(screen.getByRole("button", { name: /运行/ }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan", revision: 1, requestId: "request-id", parameters: {} })));
  });

  it("protects a dirty draft when an AI plan revision arrives", async () => {
    render(<TestPlanPage />, { wrapper: Wrapper });
    const name = await screen.findByDisplayValue(plan.name);
    await userEvent.type(name, " 本地修改");
    await act(async () => subscribers.get("testPlan")?.({ planId: "plan", revision: 2 }));
    expect(await screen.findByText(/AI 或磁盘已修改当前计划/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /保存/ }).hasAttribute("disabled")).toBe(true);
  });
});
