// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestPlan, TestRunLog } from "@hardwareharness/contracts/testing";
import { TestRunLogPage } from "./TestRunLogPage.js";

const plan: TestPlan = {
  schemaVersion: 2, id: "plan", name: "日志测试", description: "", revision: 1, parameters: [], requirements: [], wiringRequirements: [], stopOnFail: false,
  regions: { prepare: [], test: [{ id: "step", type: "Delay", name: "步骤" }], cleanup: [] },
  createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z"
};

function log(events: number[], latest = events.at(-1) ?? 0): TestRunLog {
  return {
    run: { runId: "run", planId: "plan", revision: 1, planName: plan.name, state: "running", verdict: "NotSet", executionStatus: "Running", cleanupStatus: "NotRequired", safetyStatus: "NotRequired", outcomeKnown: true, recoveryRequired: false, coverage: { requirements: [], total: 0 }, operations: [], startedAt: plan.createdAt, sequence: latest, resultSequence: 0, pauseRequested: false, abortRequested: false, hardwareIds: [] },
    plan,
    events: events.map((sequence) => ({ sequence, at: plan.createdAt, runId: "run", type: sequence === 1 ? "run.started" : "step.started", stepId: "step" })),
    results: [],
    nextEventSequence: events.at(-1) ?? 0,
    nextResultSequence: 0,
    latestEventSequence: latest,
    latestResultSequence: 0,
    hasMoreEvents: (events.at(-1) ?? 0) < latest,
    hasMoreResults: false
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("TestRunLogPage synchronization", () => {
  it("coalesces rapid run notifications into one incremental read", async () => {
    const readRunLog = vi.fn()
      .mockResolvedValueOnce(log([1]))
      .mockResolvedValueOnce(log([2, 3], 3));
    let listener: ((payload: unknown) => void) | undefined;
    Object.defineProperty(window, "hardwareharness", { configurable: true, value: { testing: { readRunLog }, events: { subscribe: vi.fn((_name, next) => { listener = next; return () => undefined; }) } } });
    render(<TestRunLogPage runId="run" live />);
    await screen.findByText("实时");
    await act(async () => { listener?.({ runId: "run", eventSequence: 2 }); listener?.({ runId: "run", eventSequence: 3 }); });
    await waitFor(() => expect(readRunLog).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText("step.started")).length).toBeGreaterThan(0);
  });

  it("rebuilds once when an incremental sequence gap is detected", async () => {
    const readRunLog = vi.fn()
      .mockResolvedValueOnce(log([2], 2))
      .mockResolvedValueOnce(log([1, 2], 2));
    Object.defineProperty(window, "hardwareharness", { configurable: true, value: { testing: { readRunLog }, events: { subscribe: vi.fn(() => () => undefined) } } });
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText(/检测到日志序号缺口/)).toBeTruthy();
    await waitFor(() => expect(readRunLog).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("历史快照")).toBeTruthy();
  });

  it("renders a single execution timeline without empty run-level result cards", async () => {
    const value = log([1]);
    value.events = [
      { sequence: 1, at: plan.createdAt, runId: "run", type: "step.started", stepId: "step", executionId: "execution-1", region: "test" },
      { sequence: 2, at: plan.createdAt, runId: "run", type: "step.completed", stepId: "step", executionId: "execution-1", region: "test", verdict: "Pass", durationMs: 20 }
    ];
    value.nextEventSequence = 2; value.latestEventSequence = 2; value.run.sequence = 2;
    Object.defineProperty(window, "hardwareharness", { configurable: true, value: { testing: { readRunLog: vi.fn(async () => value) }, events: { subscribe: vi.fn(() => () => undefined) } } });
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByLabelText("测试执行轨迹")).toBeTruthy();
    expect(screen.queryByText("实时采集数据")).toBeNull();
    expect(screen.queryByText("结果与证据")).toBeNull();
    expect(screen.queryByText("本次运行没有物理操作")).toBeNull();
  });

  it("shows a single measurement as a value instead of an empty chart", async () => {
    const value = log([1]);
    value.events = [{ sequence: 1, at: plan.createdAt, runId: "run", type: "step.started", stepId: "step", executionId: "execution-1", region: "test" }];
    value.results = [{ sequence: 1, at: plan.createdAt, name: "电压", kind: "measurement", sourceStepId: "step", executionId: "execution-1", value: 3.3, unit: "V" }];
    value.nextResultSequence = 1; value.latestResultSequence = 1; value.run.resultSequence = 1;
    Object.defineProperty(window, "hardwareharness", { configurable: true, value: { testing: { readRunLog: vi.fn(async () => value) }, events: { subscribe: vi.fn(() => () => undefined) } } });
    const { container } = render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText("3.30000")).toBeTruthy();
    expect(screen.getByText("单次测量")).toBeTruthy();
    expect(container.querySelector("svg[aria-label$='测量曲线']")).toBeNull();
  });

  it("renders parallel child executions as named lanes", async () => {
    const parallelPlan: TestPlan = { ...plan, regions: { prepare: [], test: [{ id: "parallel", type: "Parallel", name: "并行采集", children: [{ id: "left", type: "Delay", name: "左路" }, { id: "right", type: "Delay", name: "右路" }] }], cleanup: [] } };
    const value = log([1]); value.plan = parallelPlan;
    value.events = [
      { sequence: 1, at: plan.createdAt, runId: "run", type: "step.started", stepId: "parallel", executionId: "parallel-1", region: "test" },
      { sequence: 2, at: plan.createdAt, runId: "run", type: "step.started", stepId: "left", executionId: "left-1", parentExecutionId: "parallel-1", region: "test", branchIndex: 0 },
      { sequence: 3, at: plan.createdAt, runId: "run", type: "step.started", stepId: "right", executionId: "right-1", parentExecutionId: "parallel-1", region: "test", branchIndex: 1 }
    ];
    value.nextEventSequence = 3; value.latestEventSequence = 3; value.run.sequence = 3; value.run.activeExecutionIds = ["left-1", "right-1"];
    Object.defineProperty(window, "hardwareharness", { configurable: true, value: { testing: { readRunLog: vi.fn(async () => value) }, events: { subscribe: vi.fn(() => () => undefined) } } });
    render(<TestRunLogPage runId="run" live={false} />);
    expect(await screen.findByText("并行分支 1")).toBeTruthy();
    expect(screen.getByText("并行分支 2")).toBeTruthy();
    expect(screen.getByText("左路")).toBeTruthy();
    expect(screen.getByText("右路")).toBeTruthy();
  });
});
