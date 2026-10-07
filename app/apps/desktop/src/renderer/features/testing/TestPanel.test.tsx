// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../ui/toast";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRunRequested } from "../../lib/run-focus.js";
import { useBenchRun } from "../signals/use-bench-run.js";
import { TestPanel } from "./TestPanel.js";
import { installTestingApi, makeItem, makePlan, makeSummary } from "./testing-api.fixture.js";

const plan = makePlan();
let api: ReturnType<typeof installTestingApi>;

function Panel() {
  return <TestPanel bench={useBenchRun()} />;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

beforeEach(() => {
  api = installTestingApi([plan], [makeItem("plan", plan.name)]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("TestPanel", () => {
  it("adds a step in the editor dialog, saves, validates and starts the saved revision", async () => {
    const requested = vi.fn();
    const stop = onRunRequested(requested);
    render(<Panel />, { wrapper: Wrapper });
    expect(await screen.findByText("流程还没有步骤，点击「编辑」添加。")).toBeTruthy();
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
    await waitFor(() => expect(api.testing.validatePlan).toHaveBeenCalledWith({ planId: "plan" }));
    await userEvent.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(api.testing.startRun).toHaveBeenCalledWith({
      input: expect.objectContaining({
        planId: "plan", revision: 1, executionRevision: "exec", requestId: "request-id", parameters: {}
      })
    }));
    // The started run opens on the bench's signal view.
    await waitFor(() => expect(requested).toHaveBeenCalledWith("run"));
    stop();
  });

  it("protects a dirty draft when an AI plan revision arrives", async () => {
    render(<Panel />, { wrapper: Wrapper });
    await screen.findByText("流程还没有步骤，点击「编辑」添加。");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /计划属性/ }));
    const name = await within(dialog).findByDisplayValue(plan.name);
    await userEvent.type(name, " 本地修改");
    await act(async () => api.subscribers.get("testPlan")?.({ planId: "plan", revision: 2 }));
    expect(await within(dialog).findByText(/AI 或磁盘已修改当前计划/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "重载 AI 版本" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "另存本地草稿" })).toBeTruthy();
    // Closed, the panel still marks the draft unsaved and conflicting.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("未保存")).toBeTruthy();
    expect(screen.getByText("冲突")).toBeTruthy();
  });

  it("shows the latest result in the item list and keeps raw run state out of the flow toolbar", async () => {
    api = installTestingApi([plan], [makeItem("plan", plan.name, {
      runId: "run-old", state: "aborted", verdict: "Aborted", durationMs: 1200
    })]);
    render(<Panel />, { wrapper: Wrapper });
    await screen.findByText("流程还没有步骤，点击「编辑」添加。");
    const toolbar = screen.getByRole("toolbar", { name: "测试流程操作" });
    expect(within(toolbar).queryByText(/Aborted/)).toBeNull();
    expect(screen.getAllByText("中止", { exact: true }).length).toBeGreaterThan(0);
  });
});
