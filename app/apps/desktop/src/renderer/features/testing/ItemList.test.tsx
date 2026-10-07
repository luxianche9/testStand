// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../ui/toast";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBenchRun } from "../signals/use-bench-run.js";
import { TestPanel } from "./TestPanel.js";
import { installTestingApi, makeItem, makePlan } from "./testing-api.fixture.js";

const plans = [makePlan("alpha", "上电自检"), makePlan("beta", "串口回环"), makePlan("gamma", "电源纹波")];
const items = [
  makeItem("alpha", "上电自检", { runId: "r1", state: "completed", verdict: "Pass", durationMs: 1500 }),
  makeItem("beta", "串口回环", { runId: "r2", state: "completed", verdict: "Fail", durationMs: 800 }),
  makeItem("gamma", "电源纹波")
];
let api: ReturnType<typeof installTestingApi>;

function Panel() {
  return <TestPanel bench={useBenchRun()} />;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

beforeEach(() => {
  api = installTestingApi(plans, items);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("功能测试项列表", () => {
  it("summarises the current unit's results", async () => {
    render(<Panel />, { wrapper: Wrapper });
    const list = await screen.findByRole("complementary", { name: "功能测试项列表" });
    await within(list).findByText("上电自检");
    expect(screen.getByTestId("item-summary").textContent).toBe("1 PASS · 1 FAIL · 1 未测");
    expect(within(list).getByText("PASS")).toBeTruthy();
    expect(within(list).getByText("FAIL")).toBeTruthy();
    expect(within(list).getByText("未测")).toBeTruthy();
  });

  it("counts the selection and runs checked items in list order", async () => {
    render(<Panel />, { wrapper: Wrapper });
    await screen.findByRole("checkbox", { name: "选择 电源纹波" });
    await userEvent.click(screen.getByRole("checkbox", { name: "选择 电源纹波" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择 上电自检" }));
    expect(screen.getByText("已选 2")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "全选功能测试项" }).getAttribute("data-state"))
      .toBe("indeterminate");
    await userEvent.click(screen.getByRole("switch", { name: "失败即停" }));
    await userEvent.click(screen.getByRole("button", { name: "运行所选 (2)" }));
    await waitFor(() => expect(api.testing.startBatch).toHaveBeenCalledWith({
      input: { requestId: "request-id", planIds: ["alpha", "gamma"], stopOnFail: true }
    }));
    expect(await screen.findByRole("progressbar", { name: "批量运行进度" })).toBeTruthy();
  });

  it("runs every item via select-all", async () => {
    render(<Panel />, { wrapper: Wrapper });
    const all = await screen.findByRole("checkbox", { name: "全选功能测试项" });
    await waitFor(() => expect(all.hasAttribute("disabled")).toBe(false));
    await userEvent.click(all);
    expect(screen.getByRole("button", { name: "运行所选 (3)" })).toBeTruthy();
    await userEvent.click(all);
    expect(screen.getByRole("button", { name: "运行所选 (0)" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(all);
    await userEvent.click(screen.getByRole("button", { name: "运行所选 (3)" }));
    await waitFor(() => expect(api.testing.startBatch).toHaveBeenCalledWith({
      input: { requestId: "request-id", planIds: ["alpha", "beta", "gamma"], stopOnFail: false }
    }));
  });
});
