// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../ui/toast";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { TestPlan, TestRunEvent } from "@teststand/contracts/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRunRequested } from "../../lib/run-focus.js";
import { useBenchRun } from "../signals/use-bench-run.js";
import { TestPanel } from "./TestPanel.js";
import { installTestingApi, makePlan, makeRun, makeSummary } from "./testing-api.fixture.js";

const plan = makePlan();
let api: ReturnType<typeof installTestingApi>;

/** The flow with two 功能组, each holding one delay. */
function flowWithFeatures(): TestPlan {
  const flow = makePlan();
  flow.regions.test = [
    { id: "power", type: "Feature", name: "供电", children: [{ id: "wait", type: "Delay" }] },
    { id: "comm", type: "Feature", name: "通信", children: [{ id: "wait_2", type: "Delay" }] }
  ];
  return flow;
}

function Panel() {
  return <TestPanel bench={useBenchRun()} />;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

beforeEach(() => {
  api = installTestingApi([plan]);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("TestPanel", () => {
  it("adds a step in the editor dialog, saves, validates and starts the saved revision", async () => {
    const requested = vi.fn();
    const stop = onRunRequested(requested);
    render(<Panel />, { wrapper: Wrapper });
    expect(await screen.findByText("流程还没有步骤，点击「编辑」添加。")).toBeTruthy();
    expect(api.testing.loadPlan).toHaveBeenCalledWith({ planId: "flow" });
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("button", { name: /延时/ }));
    expect(within(dialog).getAllByLabelText("删除步骤")).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.testing.savePlan).toHaveBeenCalledOnce());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The flow in the sidebar shows the step.
    const flow = screen.getByRole("tree", { name: "测试流程" });
    expect(within(flow).getAllByRole("treeitem")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "校验" }));
    await waitFor(() => expect(api.testing.validatePlan).toHaveBeenCalledWith({ planId: "flow" }));
    await userEvent.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(api.testing.startRun).toHaveBeenCalledWith({
      input: expect.objectContaining({
        planId: "flow", revision: 1, executionRevision: "exec", requestId: "request-id", parameters: {}
      })
    }));
    // A flow without 功能组 runs as a whole.
    expect(api.testing.startRun).not.toHaveBeenCalledWith({
      input: expect.objectContaining({ features: expect.anything() })
    });
    // The started run opens on the bench's signal view.
    await waitFor(() => expect(requested).toHaveBeenCalledWith("run"));
    stop();
  });

  it("runs only the ticked 功能组 and remembers the ones left out", async () => {
    api = installTestingApi([flowWithFeatures()]);
    const view = render(<Panel />, { wrapper: Wrapper });
    const power = await screen.findByRole("checkbox", { name: "选择 供电" });
    expect(screen.getByText("已选 2/2 功能组")).toBeTruthy();
    expect(screen.getAllByText("未测")).toHaveLength(2);

    await userEvent.click(power);
    expect(screen.getByText("已选 1/2 功能组")).toBeTruthy();
    // Ticking does not fold the group.
    expect(screen.getByRole("treeitem", { name: /供电/ }).getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(api.testing.startRun).toHaveBeenCalledWith({
      input: expect.objectContaining({ planId: "flow", features: ["comm"] })
    }));

    await userEvent.click(screen.getByRole("checkbox", { name: "选择 通信" }));
    expect(screen.getByText("已选 0/2 功能组")).toBeTruthy();
    expect(screen.getByRole("button", { name: "运行" }).hasAttribute("disabled")).toBe(true);

    view.unmount();
    render(<Panel />, { wrapper: Wrapper });
    expect(await screen.findByText("已选 0/2 功能组")).toBeTruthy();
  });

  it("shows each 功能组's result in the flow's latest run", async () => {
    const flow = flowWithFeatures();
    api = installTestingApi([flow]);
    const events: TestRunEvent[] = [
      { sequence: 1, at: "2026-09-17T00:00:01Z", runId: "run-old", type: "step.started", region: "test",
        stepId: "power", executionId: "e-power" },
      { sequence: 2, at: "2026-09-17T00:00:02Z", runId: "run-old", type: "step.completed", region: "test",
        stepId: "power", executionId: "e-power", verdict: "Fail" },
      { sequence: 3, at: "2026-09-17T00:00:03Z", runId: "run-old", type: "step.skipped", region: "test",
        stepId: "comm", executionId: "e-comm", reason: "notSelected" }
    ];
    api.testing.listRuns.mockResolvedValue({ items: [makeSummary("run-old", flow.name, "2026-09-17T00:00:00Z")] });
    api.testing.readRunLog.mockImplementation(async () => ({
      run: makeRun(flow, { runId: "run-old", state: "completed", verdict: "Fail", features: ["power"] }),
      plan: structuredClone(flow), events, results: [],
      nextEventSequence: 4, nextResultSequence: 0, latestEventSequence: 3, latestResultSequence: 0,
      hasMoreEvents: false, hasMoreResults: false
    }) as never);
    render(<Panel />, { wrapper: Wrapper });
    expect(await screen.findByText("FAIL")).toBeTruthy();
    expect(screen.getByText("未选")).toBeTruthy();
    expect(api.testing.listRuns).toHaveBeenCalledWith({ input: { planId: "flow", limit: 1 } });
    // Raw run state stays out of the flow toolbar.
    const toolbar = screen.getByRole("toolbar", { name: "测试流程操作" });
    expect(within(toolbar).queryByText(/Fail/)).toBeNull();
  });

  it("protects a dirty draft when an AI flow revision arrives", async () => {
    render(<Panel />, { wrapper: Wrapper });
    await screen.findByText("流程还没有步骤，点击「编辑」添加。");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /计划属性/ }));
    const name = await within(dialog).findByDisplayValue(plan.name);
    await userEvent.type(name, " 本地修改");
    await act(async () => api.subscribers.get("testPlan")?.({ planId: "flow", revision: 2 }));
    expect(await within(dialog).findByText(/AI 或磁盘已修改测试流程/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "重载 AI 版本" })).toBeTruthy();
    // Closed, the panel still marks the draft unsaved and conflicting.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("未保存")).toBeTruthy();
    expect(screen.getByText("冲突")).toBeTruthy();

    // Keeping the local draft saves it over the latest revision.
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "保留本地草稿" }));
    await waitFor(() => expect(api.testing.savePlan).toHaveBeenCalledWith({
      plan: expect.objectContaining({ id: "flow", name: `${plan.name} 本地修改` }), baseRevision: 1
    }));
    await waitFor(() => expect(screen.queryByText("冲突")).toBeNull());
  });
});
