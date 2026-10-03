// @vitest-environment jsdom

import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render as renderElement, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestPlan, TestRunEvent, TestRunLog } from "@teststand/contracts/testing";
import { TestRunLogPage } from "./TestRunLogPage.js";
import { makePlan, makeRun } from "./testing-api.fixture.js";

const at = "2026-09-18T00:00:00Z";
const plan: TestPlan = {
  ...makePlan("plan", "日志测试"),
  regions: { prepare: [], test: [{ id: "step", type: "Delay", name: "步骤" }], cleanup: [] },
  createdAt: at,
  updatedAt: at
};

function event(sequence: number, stepId: string, extra: Partial<TestRunEvent> = {}): TestRunEvent {
  return { sequence, at, runId: "run", type: "step.started", stepId, region: "test", ...extra };
}

function log(events: number[], latest = events.at(-1) ?? 0): TestRunLog {
  return {
    run: makeRun(plan, { startedAt: at, sequence: latest }),
    plan,
    events: events.map((sequence) => ({
      sequence, at, runId: "run", type: sequence === 1 ? "run.started" : "step.started", stepId: "step"
    })),
    results: [],
    nextEventSequence: events.at(-1) ?? 0,
    nextResultSequence: 0,
    latestEventSequence: latest,
    latestResultSequence: 0,
    hasMoreEvents: (events.at(-1) ?? 0) < latest,
    hasMoreResults: false
  };
}

function install(readRunLog: unknown, subscribe: unknown = vi.fn(() => () => undefined)) {
  Object.defineProperty(window, "teststand", {
    configurable: true,
    value: { testing: { readRunLog, listStepCatalog: vi.fn(async () => []) }, events: { subscribe } }
  });
}

/** Step type labels come from the catalog query, so the page needs a query client. */
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderElement(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("TestRunLogPage synchronization", () => {
  it("coalesces rapid run notifications into one incremental read", async () => {
    const readRunLog = vi.fn()
      .mockResolvedValueOnce(log([1]))
      .mockResolvedValueOnce(log([2, 3], 3));
    let listener: ((payload: unknown) => void) | undefined;
    install(readRunLog, vi.fn((_name: string, next: (payload: unknown) => void) => {
      listener = next;
      return () => undefined;
    }));
    render(<TestRunLogPage runId="run" live />);
    await screen.findByText("实时");
    await act(async () => {
      listener?.({ runId: "run", eventSequence: 2 });
      listener?.({ runId: "run", eventSequence: 3 });
    });
    await waitFor(() => expect(readRunLog).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText("step.started")).length).toBeGreaterThan(0);
  });

  it("rebuilds once when an incremental sequence gap is detected", async () => {
    const readRunLog = vi.fn()
      .mockResolvedValueOnce(log([2], 2))
      .mockResolvedValueOnce(log([1, 2], 2));
    install(readRunLog);
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText(/检测到日志序号缺口/)).toBeTruthy();
    await waitFor(() => expect(readRunLog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("正在补齐日志")).toBeNull());
    expect(screen.queryByText("历史快照")).toBeNull();
  });

  it("renders a single execution timeline without empty run-level result cards", async () => {
    const value = log([1]);
    value.events = [
      event(1, "step", { executionId: "execution-1" }),
      event(2, "step", { type: "step.completed", executionId: "execution-1", verdict: "Pass", durationMs: 20 })
    ];
    value.nextEventSequence = 2; value.latestEventSequence = 2; value.run.sequence = 2;
    install(vi.fn(async () => value));
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByLabelText("测试执行轨迹")).toBeTruthy();
    expect(screen.queryByText("实时采集数据")).toBeNull();
    expect(screen.queryByText("结果与证据")).toBeNull();
    expect(screen.queryByText("本次运行没有物理操作")).toBeNull();
  });

  it("shows a single measurement as a value instead of an empty chart", async () => {
    const value = log([1]);
    value.events = [event(1, "step", { executionId: "execution-1" })];
    value.results = [{
      sequence: 1, at, name: "电压", kind: "measurement", sourceStepId: "step", executionId: "execution-1",
      value: 3.3, unit: "V"
    }];
    value.nextResultSequence = 1; value.latestResultSequence = 1; value.run.resultSequence = 1;
    install(vi.fn(async () => value));
    const { container } = render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText("3.30000")).toBeTruthy();
    expect(screen.getByText("单次测量")).toBeTruthy();
    expect(container.querySelector("svg[aria-label$='测量曲线']")).toBeNull();
  });

  it("renders parallel child executions as named lanes", async () => {
    const parallel = {
      id: "parallel", type: "Parallel", name: "并行采集",
      children: [{ id: "left", type: "Delay", name: "左路" }, { id: "right", type: "Delay", name: "右路" }]
    };
    const value = log([1]);
    value.plan = { ...plan, regions: { prepare: [], test: [parallel], cleanup: [] } };
    value.events = [
      event(1, "parallel", { executionId: "parallel-1" }),
      event(2, "left", { executionId: "left-1", parentExecutionId: "parallel-1", branchIndex: 0 }),
      event(3, "right", { executionId: "right-1", parentExecutionId: "parallel-1", branchIndex: 1 })
    ];
    value.nextEventSequence = 3; value.latestEventSequence = 3; value.run.sequence = 3;
    value.run.activeExecutionIds = ["left-1", "right-1"];
    install(vi.fn(async () => value));
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText("并行分支 1")).toBeTruthy();
    expect(screen.getByText("并行分支 2")).toBeTruthy();
    expect(screen.getByText("左路")).toBeTruthy();
    expect(screen.getByText("右路")).toBeTruthy();
  });

  it("shows one verdict and only the side statuses that went wrong", async () => {
    const value = log([1]);
    value.run = {
      ...value.run, state: "completed", verdict: "Fail", executionStatus: "Succeeded",
      cleanupStatus: "Succeeded", safetyStatus: "Verified",
      coverage: {
        total: 2,
        requirements: [
          { requirementId: "a", name: "电压正常", status: "Passed" },
          { requirementId: "b", name: "继电器吸合", status: "Failed" }
        ]
      }
    };
    install(vi.fn(async () => value));
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText("FAIL")).toBeTruthy();
    expect(screen.getByText("验收 1/2")).toBeTruthy();
    expect(screen.getByText("继电器吸合")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/清理|安全|结果确定/)).toBeNull();

    value.run = { ...value.run, cleanupStatus: "Failed", outcomeKnown: false, recoveryRequired: true };
    install(vi.fn(async () => structuredClone(value)));
    cleanup();
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText("清理失败")).toBeTruthy();
    expect(screen.getByText("结果未知，需要人工处理")).toBeTruthy();
  });
});
