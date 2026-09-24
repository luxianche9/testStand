// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../ui/toast";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestPlanPage } from "./TestPlanPage.js";
import { installTestingApi, makeItem, makePlan, makeSummary } from "./testing-api.fixture.js";

const plan = makePlan();
let api: ReturnType<typeof installTestingApi>;

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

describe("TestPlanPage", () => {
  it("adds a catalog step once, saves, validates and starts the saved revision", async () => {
    render(<TestPlanPage />, { wrapper: Wrapper });
    await screen.findByDisplayValue(plan.name);
    await userEvent.click(screen.getByRole("tab", { name: "组件库" }));
    await userEvent.click(await screen.findByRole("button", { name: /延时/ }));
    expect(screen.getAllByLabelText("删除步骤")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.testing.savePlan).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "校验" }));
    await waitFor(() => expect(api.testing.validatePlan).toHaveBeenCalledWith("plan"));
    await userEvent.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(api.testing.startRun).toHaveBeenCalledWith(expect.objectContaining({
      planId: "plan", revision: 1, executionRevision: "exec", requestId: "request-id", parameters: {}
    })));
  });

  it("protects a dirty draft when an AI plan revision arrives", async () => {
    render(<TestPlanPage />, { wrapper: Wrapper });
    const name = await screen.findByDisplayValue(plan.name);
    await userEvent.type(name, " 本地修改");
    await act(async () => api.subscribers.get("testPlan")?.({ planId: "plan", revision: 2 }));
    expect(await screen.findByText(/AI 或磁盘已修改当前计划/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "重载 AI 版本" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "另存本地草稿" })).toBeTruthy();
  });

  it("appends and deduplicates run history pages for the selected item", async () => {
    const first = makeSummary("run-1", `${plan.name} run-1`, "2026-09-18T00:00:00Z");
    const second = makeSummary("run-2", `${plan.name} run-2`, "2026-09-17T00:00:00Z");
    api.testing.listRuns.mockImplementation(async (input?: { cursor?: string }) => input?.cursor
      ? { items: [first, second] }
      : { items: [first], nextCursor: "page-2" });
    render(<TestPlanPage />, { wrapper: Wrapper });
    await screen.findByDisplayValue(plan.name);
    await userEvent.click(screen.getByRole("tab", { name: "运行日志" }));
    expect(await screen.findByText(`${plan.name} run-1`)).toBeTruthy();
    expect(api.testing.listRuns).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan" }));
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText(`${plan.name} run-2`)).toBeTruthy();
    expect(screen.getAllByText(`${plan.name} run-1`)).toHaveLength(1);
  });

  it("shows the latest result in the item list and keeps raw run state out of the editor header", async () => {
    api = installTestingApi([plan], [makeItem("plan", plan.name, {
      runId: "run-old", state: "aborted", verdict: "Aborted", durationMs: 1200
    })]);
    render(<TestPlanPage />, { wrapper: Wrapper });
    await screen.findByDisplayValue(plan.name);
    const toolbar = screen.getByRole("toolbar", { name: "测试流程工具栏" });
    expect(within(toolbar).queryByText(/Aborted/)).toBeNull();
    expect(screen.getAllByText("中止", { exact: true }).length).toBeGreaterThan(0);
  });
});
