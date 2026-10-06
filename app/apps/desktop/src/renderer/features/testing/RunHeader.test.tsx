// @vitest-environment jsdom

import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render as renderElement, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestPlan, TestRunEvent, TestRunLog } from "@teststand/contracts/testing";
import { buildExecutionTrace } from "./run-log-model.js";
import { RunHeader } from "./RunHeader.js";
import { useRunLog } from "./useRunLog.js";
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

/** The header as the run monitor drives it: the incrementally synchronised log of one run. */
function Header({ runId, live }: { runId: string; live: boolean }) {
  const state = useRunLog(runId, live);
  const trace = useMemo(
    () => state.log && buildExecutionTrace(state.log.plan, state.log.events, state.log.results, []),
    [state.log]
  );
  return (
    <RunHeader
      state={state}
      trace={trace}
      activeExecutionIds={[]}
      problemExecutionId={undefined}
      following={live}
      onCurrent={() => undefined}
      onProblem={() => undefined}
    />
  );
}

function render(runId: string, live: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderElement(<QueryClientProvider client={client}><Header runId={runId} live={live} /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("RunHeader", () => {
  it("coalesces rapid run notifications into one incremental read", async () => {
    const readRunLog = vi.fn()
      .mockResolvedValueOnce(log([1]))
      .mockResolvedValueOnce(log([2, 3], 3));
    let listener: ((payload: unknown) => void) | undefined;
    install(readRunLog, vi.fn((_name: string, next: (payload: unknown) => void) => {
      listener = next;
      return () => undefined;
    }));
    render("run", true);
    await screen.findByText("实时");
    await act(async () => {
      listener?.({ runId: "run", eventSequence: 2 });
      listener?.({ runId: "run", eventSequence: 3 });
    });
    await waitFor(() => expect(readRunLog).toHaveBeenCalledTimes(2));
    expect(readRunLog).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "run" }));
  });

  it("rebuilds once when an incremental sequence gap is detected", async () => {
    const readRunLog = vi.fn()
      .mockResolvedValueOnce(log([2], 2))
      .mockResolvedValueOnce(log([1, 2], 2));
    install(readRunLog);
    render("run", false);
    expect(await screen.findByText(/检测到日志序号缺口/)).toBeTruthy();
    await waitFor(() => expect(readRunLog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("正在补齐日志")).toBeNull());
    expect(screen.queryByText("历史快照")).toBeNull();
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
    render("run", false);
    expect(await screen.findByText("FAIL")).toBeTruthy();
    expect(screen.getByText("验收 1/2")).toBeTruthy();
    expect(screen.getByText("继电器吸合")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/清理|安全|结果确定/)).toBeNull();

    value.run = { ...value.run, cleanupStatus: "Failed", outcomeKnown: false, recoveryRequired: true };
    install(vi.fn(async () => structuredClone(value)));
    cleanup();
    render("run", false);
    expect(await screen.findByText("清理失败")).toBeTruthy();
    expect(screen.getByText("结果未知，需要人工处理")).toBeTruthy();
  });
});
