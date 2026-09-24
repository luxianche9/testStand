import { describe, expect, it } from "vitest";
import type { TestOperationSnapshot, TestPlan, TestResult, TestRunEvent } from "@hardwareharness/contracts/testing";
import { buildExecutionTrace, downsample, groupMeasurements, projectStepStates } from "./run-log-model.js";

const at = "2026-09-18T00:00:00Z";
const plan: TestPlan = {
  schemaVersion: 2, id: "plan", name: "Plan", description: "", revision: 1, parameters: [], requirements: [],
  stopOnFail: false,
  regions: {
    prepare: [{ id: "prepare", type: "Delay" }],
    test: [{ id: "group", type: "Group", children: [{ id: "measure", type: "InvokeTool" }] }],
    cleanup: []
  },
  createdAt: at, updatedAt: at
};

/** A test-region step event; `second` offsets the timestamp. */
function event(sequence: number, extra: Partial<TestRunEvent>, second = 0): TestRunEvent {
  return {
    sequence, at: `2026-09-18T00:00:0${second}Z`, runId: "run", type: "step.started", region: "test", ...extra
  };
}

function measurement(sequence: number, extra: Partial<TestResult>): TestResult {
  return { sequence, at, name: "AI", kind: "measurement", sourceStepId: "measure", value: 0, ...extra };
}

describe("run log projection", () => {
  it("projects nested step state and duration from the event stream", () => {
    const events: TestRunEvent[] = [
      event(1, { stepId: "measure" }),
      event(2, { type: "step.completed", stepId: "measure", verdict: "Pass", durationMs: 1000 }, 1)
    ];
    expect(projectStepStates(plan, events).measure).toMatchObject({ state: "Pass", durationMs: 1000 });
    expect(projectStepStates(plan, events).prepare?.state).toBe("waiting");
  });

  it("groups numeric measurement fields by source, field and unit", () => {
    const results: TestResult[] = [
      measurement(1, { unit: "V", value: { ai1: 1, ai2: 2 } }),
      measurement(2, { unit: "V", value: { ai1: 1.5, ai2: 2.5 } })
    ];
    expect(groupMeasurements(results)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "measure::value.ai1::V",
        points: expect.arrayContaining([expect.objectContaining({ value: 1.5 })])
      }),
      expect.objectContaining({ key: "measure::value.ai2::V" })
    ]));
  });

  it("limits rendered points while retaining end-of-series evidence", () => {
    const points = Array.from({ length: 5000 }, (_, sequence) => ({
      sequence, at: String(sequence), value: Math.sin(sequence)
    }));
    const sampled = downsample(points, 2000);
    expect(sampled.length).toBeLessThanOrEqual(2000);
    expect(sampled.at(-1)?.sequence).toBe(4999);
  });

  it("keeps repeated executions of one static step separate and attaches evidence by execution id", () => {
    const repeatPlan: TestPlan = {
      ...plan,
      regions: {
        prepare: [],
        test: [{ id: "repeat", type: "Repeat", count: 2, children: [{ id: "measure", type: "InvokeTool" }] }],
        cleanup: []
      }
    };
    const child = { stepId: "measure", parentExecutionId: "repeat-1" };
    const events: TestRunEvent[] = [
      event(1, { stepId: "repeat", executionId: "repeat-1" }),
      {
        sequence: 2, at: "2026-09-18T00:00:01Z", runId: "run", type: "loop.iteration.started",
        executionId: "repeat-1", iterationIndex: 0, iterationCount: 2
      },
      event(3, { ...child, executionId: "measure-1", iterationIndex: 0, iterationCount: 2 }, 1),
      event(4, { ...child, type: "step.completed", executionId: "measure-1", iterationIndex: 0, verdict: "Pass" }, 2),
      event(5, { ...child, executionId: "measure-2", iterationIndex: 1, iterationCount: 2 }, 3),
      event(6, { ...child, type: "step.completed", executionId: "measure-2", iterationIndex: 1, verdict: "Fail" }, 4)
    ];
    const results: TestResult[] = [
      measurement(1, { at: events[3]!.at, name: "first", executionId: "measure-1", value: 1 }),
      measurement(2, { at: events[5]!.at, name: "second", executionId: "measure-2", value: 2 })
    ];
    const trace = buildExecutionTrace(repeatPlan, events, results, []);
    expect(trace.byExecutionId.get("measure-1")?.results[0]?.name).toBe("first");
    expect(trace.byExecutionId.get("measure-2")?.results[0]?.name).toBe("second");
    expect(trace.byExecutionId.get("repeat-1")?.iterations.map((item) => item.index)).toEqual([0, 1]);
  });

  it("orders parallel lanes by branch index even when events arrive out of order", () => {
    const parallelPlan: TestPlan = {
      ...plan,
      regions: {
        prepare: [],
        test: [{
          id: "parallel", type: "Parallel", children: [{ id: "left", type: "Delay" }, { id: "right", type: "Delay" }]
        }],
        cleanup: []
      }
    };
    const events: TestRunEvent[] = [
      event(3, { stepId: "right", executionId: "right-1", parentExecutionId: "parallel-1", branchIndex: 1 }),
      event(1, { stepId: "parallel", executionId: "parallel-1" }),
      event(2, { stepId: "left", executionId: "left-1", parentExecutionId: "parallel-1", branchIndex: 0 })
    ];
    const trace = buildExecutionTrace(parallelPlan, events, [], []);
    expect(trace.byExecutionId.get("parallel-1")?.children.map((item) => item.stepId)).toEqual(["left", "right"]);
  });

  it("does not guess operation ownership when repeated steps lack an execution id", () => {
    const operations: TestOperationSnapshot[] = [{
      operationId: "op", runId: "run", hardwareId: "dev", toolName: "read", stepId: "measure",
      state: "succeeded", outcomeKnown: true, recoveryRequired: false
    }];
    const repeatedEvents: TestRunEvent[] = [
      event(1, { stepId: "group", executionId: "group-1" }),
      event(2, { stepId: "measure", executionId: "measure-1", parentExecutionId: "group-1" }),
      event(3, { stepId: "measure", executionId: "measure-2", parentExecutionId: "group-1" })
    ];
    expect(buildExecutionTrace(plan, repeatedEvents, [], operations).unmatchedOperations).toHaveLength(1);
  });
});
