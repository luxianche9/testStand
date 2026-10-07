import { describe, expect, it } from "vitest";
import type { TestPlan, TestResult, TestRunEvent } from "@teststand/contracts/testing";
import { flowChildren, resultEvidence, resultSummary } from "./run-format.js";
import { buildExecutionTrace } from "./run-log-model.js";

function verdict(extra: Record<string, unknown>): TestResult {
  return { sequence: 1, at: "2026-09-18T00:00:00Z", name: "observe", kind: "verdict", ...extra };
}

describe("run format", () => {
  it("summarizes stream verdicts by what decided them", () => {
    expect(resultSummary(verdict({
      verdict: "Fail",
      evidence: { assertions: [
        { metric: "count", op: "ge", value: 3, actual: 4, passed: true },
        { metric: "mean", op: "within", value: [5.95, 6.05], actual: 0.2075, passed: false }
      ] }
    }))).toBe("失败，count 4 ≥ 3 ✓，mean 0.2075 ∈ [5.95, 6.05] ✗");
    expect(resultSummary(verdict({ verdict: "Pass", evidence: { latencyMs: 499.989 } }))).toBe("通过，窗口内 500 ms 满足");
    expect(resultSummary(verdict({
      verdict: "Inconclusive", evidence: { reason: "insufficient_evidence", message: "2 samples in the window, need 3" }
    }))).toBe("无法判定，insufficient_evidence：2 samples in the window, need 3");
    expect(resultSummary(verdict({ verdict: "Pass", stepType: "Guard", evidence: {} }))).toBe("通过，全程未越限");
    expect(resultSummary(verdict({ verdict: "Fail", evidence: { message: "no matching record before the deadline" } })))
      .toBe("失败，no matching record before the deadline");
  });

  it("reads the evidence grade, falling back to the verdict evidence", () => {
    expect(resultEvidence(verdict({ evidenceType: "P" }))).toEqual({ grade: "P", label: "DUT 协议回报" });
    expect(resultEvidence(verdict({ evidence: { evidenceType: "T1" } }))?.grade).toBe("T1");
    expect(resultEvidence(verdict({ evidenceType: "note" }))).toBeUndefined();
  });
});

describe("flow children", () => {
  it("lists what a step contains, including the steps not reached yet", () => {
    const at = "2026-09-18T00:00:00Z";
    const plan: TestPlan = {
      schemaVersion: 2, id: "plan", name: "Plan", description: "", revision: 1, parameters: [], requirements: [],
      stopOnFail: false, createdAt: at, updatedAt: at,
      regions: {
        prepare: [],
        test: [
          { id: "close", type: "InvokeTool", name: "闭合继电器" },
          { id: "group", type: "Group", name: "测量组", children: [{ id: "read", type: "InvokeTool", name: "读电压" }] }
        ],
        cleanup: [{ id: "open", type: "InvokeTool", name: "断开继电器" }]
      }
    };
    const events: TestRunEvent[] = [
      { sequence: 1, at, runId: "run", type: "step.started", stepId: "close", executionId: "e1", region: "test" },
      { sequence: 2, at, runId: "run", type: "step.completed", stepId: "close", executionId: "e1", region: "test",
        verdict: "Pass", durationMs: 120 },
      { sequence: 3, at, runId: "run", type: "step.started", stepId: "group", executionId: "e2", region: "test" }
    ];
    const trace = buildExecutionTrace(plan, events, [], []);
    expect(trace.regions.test.map((node) => [node.step.name, node.state])).toEqual([
      ["闭合继电器", "Pass"], ["测量组", "running"]
    ]);
    const group = trace.regions.test[1]!;
    expect(flowChildren(group).map((node) => [node.step.name, node.state])).toEqual([["读电压", "waiting"]]);
    const cleanup = trace.regions.cleanup[0]!;
    expect([cleanup.step.name, cleanup.pending, flowChildren(cleanup)]).toEqual(["断开继电器", true, []]);
  });
});
