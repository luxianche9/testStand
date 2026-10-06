// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../ui/toast";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRunMonitor } from "../../lib/run-focus.js";
import { RunMonitorPage } from "./RunMonitorPage.js";
import { installTestingApi, makeItem, makePlan, makeRun, makeSummary } from "./testing-api.fixture.js";

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

describe("RunMonitorPage", () => {
  it("lists every run, appends and deduplicates history pages", async () => {
    const first = makeSummary("run-1", `${plan.name} run-1`, "2026-09-18T00:00:00Z");
    const second = makeSummary("run-2", `${plan.name} run-2`, "2026-09-17T00:00:00Z");
    api.testing.listRuns.mockImplementation(async (request?: { input?: { cursor?: string } }) => request?.input?.cursor
      ? { items: [first, second] }
      : { items: [first], nextCursor: "page-2" });
    render(<RunMonitorPage />, { wrapper: Wrapper });
    expect(await screen.findByText(`${plan.name} run-1`)).toBeTruthy();
    expect(api.testing.listRuns).toHaveBeenCalledWith({
      input: expect.not.objectContaining({ planId: expect.anything() })
    });
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText(`${plan.name} run-2`)).toBeTruthy();
    expect(screen.getAllByText(`${plan.name} run-1`)).toHaveLength(1);
  });

  it("opens the run asked for and shows its signals while it is live", async () => {
    api.testing.currentRun.mockResolvedValue(makeRun(plan, { runId: "run-live" }));
    openRunMonitor("run-live");
    render(<RunMonitorPage />, { wrapper: Wrapper });
    await waitFor(() => expect(api.testing.getRunTimeline).toHaveBeenCalledWith({ runId: "run-live" }));
    await waitFor(() => expect(api.testing.readRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-live" })
    ));
    expect(await screen.findByRole("region", { name: "运行信号" })).toBeTruthy();
    expect(await screen.findByText("本次运行尚未记录波形数据")).toBeTruthy();
  });

  it("switches the lower pane to the decoded message table of a protocol-bound run", async () => {
    api.testing.currentRun.mockResolvedValue(makeRun(plan, { runId: "run-bus" }));
    api.testing.readRunMessages.mockImplementation(async ({ runId }: { runId: string }) => ({
      runId,
      bindings: [{
        alias: "dut", icd: "dut-v1", icdHash: "h", hardwareId: "dev", streamId: "uart", source: "dev__uart",
        recorded: true, messages: ["status"]
      }],
      messages: [{
        alias: "dut", streamId: "dut.status", kind: "message", t: 1, tb: 1, seq: 1, dir: "rx", message: "status",
        fields: { voltage: 12.34 }, raw: "aa5501", checksumOk: true
      }],
      total: 1,
      truncated: false
    }));
    openRunMonitor("run-bus");
    render(<RunMonitorPage />, { wrapper: Wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "报文 1" }));
    const table = await screen.findByRole("region", { name: "报文" });
    expect(table.textContent).toContain("AA 55 01");
    expect(table.textContent).toContain("voltage");
  });

  it("hides the signal area and re-judging for a finished run without streams", async () => {
    render(<RunMonitorPage />, { wrapper: Wrapper });
    act(() => openRunMonitor("run-old"));
    await waitFor(() => expect(api.testing.getRunTimeline).toHaveBeenCalledWith({ runId: "run-old" }));
    await waitFor(() => expect(api.testing.readRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-old" })
    ));
    expect(screen.queryByRole("region", { name: "运行信号" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复核判定" })).toBeNull();
  });

  it("folds the run history into the title bar and keeps that choice", async () => {
    localStorage.removeItem("teststand.run-history-open");
    api.testing.currentRun.mockResolvedValue(makeRun(plan, { runId: "run-fold" }));
    openRunMonitor("run-fold");
    render(<RunMonitorPage />, { wrapper: Wrapper });
    const history = () => document.querySelector('aside[aria-label="运行记录"]');
    expect(history(), "open at first").not.toBeNull();
    // The header swaps its loading row for the summary once the log arrives; click the settled one.
    await waitFor(() => expect(document.querySelector('[aria-label="正在读取运行日志…"]')).toBeNull(), {
      timeout: 5_000
    });
    await userEvent.click(await screen.findByTitle("收起运行记录", {}, { timeout: 5_000 }));
    expect(history()).toBeNull();
    expect(localStorage.getItem("teststand.run-history-open")).toBe("false");
    await userEvent.click(screen.getByTitle("展开运行记录"));
    expect(history(), "open again").not.toBeNull();
  }, 15_000);
});
