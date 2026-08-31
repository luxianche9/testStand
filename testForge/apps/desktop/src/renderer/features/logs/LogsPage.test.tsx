// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TestNodeRun, TestRun, TestRunDetail } from "@testforge/contracts/orchestration";
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

const passedRun: TestRun = {
  runId: "RUN1",
  taskId: "TASK1",
  taskName: "Persisted fixture Run",
  projectId: "P1",
  status: "passed",
  inputs: {},
  createdAt: "2026-08-18T05:51:08.000Z",
  startedAt: "2026-08-18T05:51:08.000Z",
  completedAt: "2026-08-18T05:51:12.000Z",
  summary: { passedNodes: 1, failedNodes: 0, cancelledNodes: 0 }
};

const failedRun: TestRun = {
  ...passedRun,
  runId: "RUN2",
  taskName: "通信握手测试",
  status: "failed",
  summary: { passedNodes: 5, failedNodes: 1, cancelledNodes: 0, message: "断言 ACK == 0x06" }
};

const node: TestNodeRun = {
  nodeRunId: "N1",
  runId: "RUN1",
  nodeId: "WRITE",
  nodeLabel: "Write fixture voltage",
  nodeType: "tool",
  status: "passed",
  branchPath: "steps",
  iterationPath: [],
  attempt: 1,
  startedAt: "2026-08-18T05:51:08.000Z",
  completedAt: "2026-08-18T05:51:12.000Z"
};

const detail = (run: TestRun): TestRunDetail => ({
  run,
  nodeRuns: [{ ...node, runId: run.runId, nodeRunId: `${run.runId}-N1`, nodeLabel: run.runId === "RUN1" ? "Write fixture voltage" : "断言 ACK == 0x06", status: run.status === "failed" ? "failed" : "passed" }],
  events: [{ eventId: 1, runId: run.runId, timestamp: run.createdAt, type: `run.${run.status}` }],
  nodeTotal: 1
});

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  listRuns.mockResolvedValue({ items: [failedRun, passedRun], total: 2, warnings: [], taskNames: ["Persisted fixture Run", "通信握手测试"] });
  getRun.mockImplementation(async (runId: string) => detail(runId === "RUN2" ? failedRun : passedRun));
  deleteRun.mockResolvedValue({ runId: "RUN2" });
  exportRun.mockResolvedValue({ formatVersion: 1, run: passedRun, nodeRuns: [], events: [] });
  exportText.mockResolvedValue("out.json");
  Object.defineProperty(window, "testforge", {
    configurable: true,
    value: {
      projects: { current: vi.fn(async () => ({ file: { projectId: "P1", name: "project-a" } })) },
      orchestration: { listRuns, getRun, deleteRun, exportRun, cancelRun: vi.fn(), clearCompletedRuns: vi.fn() },
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
    expect(await screen.findByRole("button", { name: /任务/ })).toBeTruthy();
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
    expect(await within(dialog).findByText("事件时间线")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "导出" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeTruthy();
  });

  it("filters by task name through listRuns", async () => {
    render(<LogsPage />, { wrapper: Wrapper });
    await screen.findByRole("cell", { name: "Persisted fixture Run" });
    await userEvent.selectOptions(screen.getByLabelText("按任务筛选"), "Persisted fixture Run");
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ taskName: "Persisted fixture Run" })));
  });
});
