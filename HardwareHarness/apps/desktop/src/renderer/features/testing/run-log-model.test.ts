import { describe, expect, it } from "vitest";
import type { TestOperationSnapshot, TestPlan, TestResult, TestRunEvent } from "@hardwareharness/contracts/testing";
import { buildExecutionTrace, downsample, groupMeasurements, projectStepStates } from "./run-log-model.js";

const plan: TestPlan = {
  schemaVersion: 2, id: "plan", name: "Plan", description: "", revision: 1, parameters: [], requirements: [], wiringRequirements: [], stopOnFail: false,
  regions: { prepare: [{ id: "prepare", type: "Delay" }], test: [{ id: "group", type: "Group", children: [{ id: "measure", type: "InvokeTool" }] }], cleanup: [] },
  createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z"
};

describe("run log projection", () => {
  it("projects nested step state and duration from the event stream", () => {
    const events: TestRunEvent[] = [
      { sequence: 1, at: "2026-09-18T00:00:00Z", runId: "run", type: "step.started", stepId: "measure" },
      { sequence: 2, at: "2026-09-18T00:00:01Z", runId: "run", type: "step.completed", stepId: "measure", verdict: "Pass", durationMs: 1000 }
    ];
    expect(projectStepStates(plan, events).measure).toMatchObject({ state: "Pass", durationMs: 1000 });
    expect(projectStepStates(plan, events).prepare?.state).toBe("waiting");
  });

  it("groups numeric measurement fields by source, field and unit", () => {
    const results: TestResult[] = [
      { sequence: 1, at: "2026-09-18T00:00:00Z", name: "AI", kind: "measurement", sourceStepId: "measure", unit: "V", value: { ai1: 1, ai2: 2 } },
      { sequence: 2, at: "2026-09-18T00:00:01Z", name: "AI", kind: "measurement", sourceStepId: "measure", unit: "V", value: { ai1: 1.5, ai2: 2.5 } }
    ];
    expect(groupMeasurements(results)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "measure::value.ai1::V", points: expect.arrayContaining([expect.objectContaining({ value: 1.5 })]) }),
      expect.objectContaining({ key: "measure::value.ai2::V" })
    ]));
  });

  it("limits rendered points while retaining end-of-series evidence", () => {
    const points = Array.from({ length: 5000 }, (_, sequence) => ({ sequence, at: String(sequence), value: Math.sin(sequence) }));
    const sampled = downsample(points, 2000);
    expect(sampled.length).toBeLessThanOrEqual(2000);
    expect(sampled.at(-1)?.sequence).toBe(4999);
  });

  it("keeps repeated executions of one static step separate and attaches evidence by execution id", () => {
    const repeatPlan: TestPlan = {
      ...plan,
      regions: { prepare: [], test: [{ id: "repeat", type: "Repeat", count: 2, children: [{ id: "measure", type: "InvokeTool" }] }], cleanup: [] }
    };
    const events: TestRunEvent[] = [
      { sequence: 1, at: "2026-09-18T00:00:00Z", runId: "run", type: "step.started", stepId: "repeat", executionId: "repeat-1", region: "test" },
      { sequence: 2, at: "2026-09-18T00:00:01Z", runId: "run", type: "loop.iteration.started", executionId: "repeat-1", iterationIndex: 0, iterationCount: 2 },
      { sequence: 3, at: "2026-09-18T00:00:01Z", runId: "run", type: "step.started", stepId: "measure", executionId: "measure-1", parentExecutionId: "repeat-1", region: "test", iterationIndex: 0, iterationCount: 2 },
      { sequence: 4, at: "2026-09-18T00:00:02Z", runId: "run", type: "step.completed", stepId: "measure", executionId: "measure-1", parentExecutionId: "repeat-1", region: "test", iterationIndex: 0, verdict: "Pass" },
      { sequence: 5, at: "2026-09-18T00:00:03Z", runId: "run", type: "step.started", stepId: "measure", executionId: "measure-2", parentExecutionId: "repeat-1", region: "test", iterationIndex: 1, iterationCount: 2 },
      { sequence: 6, at: "2026-09-18T00:00:04Z", runId: "run", type: "step.completed", stepId: "measure", executionId: "measure-2", parentExecutionId: "repeat-1", region: "test", iterationIndex: 1, verdict: "Fail" }
    ];
    const results: TestResult[] = [
      { sequence: 1, at: events[3]!.at, name: "first", kind: "measurement", sourceStepId: "measure", executionId: "measure-1", value: 1 },
      { sequence: 2, at: events[5]!.at, name: "second", kind: "measurement", sourceStepId: "measure", executionId: "measure-2", value: 2 }
    ];
    const trace = buildExecutionTrace(repeatPlan, events, results, []);
    expect(trace.byExecutionId.get("measure-1")?.results[0]?.name).toBe("first");
    expect(trace.byExecutionId.get("measure-2")?.results[0]?.name).toBe("second");
    expect(trace.byExecutionId.get("repeat-1")?.iterations.map((item) => item.index)).toEqual([0, 1]);
  });

  it("orders parallel lanes by branch index even when events arrive out of order", () => {
    const parallelPlan: TestPlan = {
      ...plan,
      regions: { prepare: [], test: [{ id: "parallel", type: "Parallel", children: [{ id: "left", type: "Delay" }, { id: "right", type: "Delay" }] }], cleanup: [] }
    };
    const events: TestRunEvent[] = [
      { sequence: 3, at: plan.createdAt, runId: "run", type: "step.started", stepId: "right", executionId: "right-1", parentExecutionId: "parallel-1", region: "test", branchIndex: 1 },
      { sequence: 1, at: plan.createdAt, runId: "run", type: "step.started", stepId: "parallel", executionId: "parallel-1", region: "test" },
      { sequence: 2, at: plan.createdAt, runId: "run", type: "step.started", stepId: "left", executionId: "left-1", parentExecutionId: "parallel-1", region: "test", branchIndex: 0 }
    ];
    const trace = buildExecutionTrace(parallelPlan, events, [], []);
    expect(trace.byExecutionId.get("parallel-1")?.children.map((item) => item.stepId)).toEqual(["left", "right"]);
  });

  it("does not guess operation ownership when repeated steps lack an execution id", () => {
    const operations: TestOperationSnapshot[] = [
      { operationId: "op", runId: "run", hardwareId: "dev", toolName: "read", stepId: "measure", state: "succeeded", outcomeKnown: true, recoveryRequired: false }
    ];
    const repeatedEvents: TestRunEvent[] = [
      { sequence: 1, at: plan.createdAt, runId: "run", type: "step.started", stepId: "group", executionId: "group-1", region: "test" },
      { sequence: 2, at: plan.createdAt, runId: "run", type: "step.started", stepId: "measure", executionId: "measure-1", parentExecutionId: "group-1", region: "test" },
      { sequence: 3, at: plan.createdAt, runId: "run", type: "step.started", stepId: "measure", executionId: "measure-2", parentExecutionId: "group-1", region: "test" }
    ];
    expect(buildExecutionTrace(plan, repeatedEvents, [], operations).unmatchedOperations).toHaveLength(1);
  });
});
