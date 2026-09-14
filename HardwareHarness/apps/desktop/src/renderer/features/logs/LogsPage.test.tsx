// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunRecord, RunDetail } from "@hardwareharness/contracts/applications";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../wiring/test-dom.js";
import { LogsPage } from "./LogsPage.js";

const listRuns = vi.fn();
const getRun = vi.fn();
const deleteRun = vi.fn();
const exportRun = vi.fn();
const exportText = vi.fn();
const subscribe = vi.fn(() => () => undefined);

const passedRun: RunRecord = {
  runId: "RUN1",
  name: "Persisted fixture Run",
  entrypoint: "workflows/main.py", hardwareIds: [], sourcePath: "snapshot", eventCount: 2,
  status: "succeeded",
  inputs: {},
  startedAt: "2026-08-18T05:51:08.000Z",
  completedAt: "2026-08-18T05:51:12.000Z",
  durationMs: 4000
};

const failedRun: RunRecord = {
  ...passedRun,
  runId: "RUN2",
  name: "通信握手测试",
  status: "failed",
  error: { category: "error", message: "断言 ACK == 0x06" }
};

const detail = (run: RunRecord): RunDetail => ({ run, hasMore: false, events: [
  { sequence: 1, runId: run.runId, timestamp: run.startedAt, type: "step.started", spanId: "step-1", name: "Write fixture voltage", data: {} },
  { sequence: 2, runId: run.runId, timestamp: run.startedAt, type: "step.completed", spanId: "step-1", data: { status: "succeeded", durationMs: 4000 } }
] });

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  listRuns.mockResolvedValue([failedRun, passedRun]);
  getRun.mockImplementation(async (runId: string) => detail(runId === "RUN2" ? failedRun : passedRun));
  deleteRun.mockResolvedValue({ runId: "RUN2" });
  exportRun.mockResolvedValue(detail(passedRun));
  exportText.mockResolvedValue("out.json");
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: {
      projects: { current: vi.fn(async () => ({ file: { projectId: "P1", name: "project-a" } })) },
      applications: { runEvents: vi.fn(async () => []), listRuns, getRun, deleteRun, exportRun, cancelRun: vi.fn(), clearCompletedRuns: vi.fn() },
      system: { exportText },
      events: { subscribe }
    }
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LogsPage ledger", () => {
  it("renders a sortable table without a side inspector", async () => {
    render(<LogsPage />, { wrapper: Wrapper });
    expect(await screen.findByRole("heading", { name: "运行日志" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /流程/ })).toBeTruthy();
    expect(await screen.findByRole("cell", { name: "Persisted fixture Run" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "通信握手测试" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "运行检查器" })).toBeNull();
  });

  it("opens the full Run detail on double-click", async () => {
    const user = userEvent.setup();
    render(<LogsPage />, { wrapper: Wrapper });
    const cell = await screen.findByRole("cell", { name: "通信握手测试" });
    await user.dblClick(cell);
    const dialog = await screen.findByRole("dialog", { name: "运行详情" });
    expect(await within(dialog).findByText(/事件时间线/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "导出" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeTruthy();
  });

  it("filters by workflow name without losing the remaining history", async () => {
    render(<LogsPage />, { wrapper: Wrapper });
    await screen.findByRole("cell", { name: "Persisted fixture Run" });
    await userEvent.selectOptions(screen.getByLabelText("按流程筛选"), "Persisted fixture Run");
    await waitFor(() => expect(screen.queryByRole("cell", { name: "通信握手测试" })).toBeNull());
  });
});
