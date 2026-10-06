import { describe, expect, it } from "vitest";
import type { RunTimeline } from "@teststand/contracts/observability";
import type { TestPlan, TestResult, TestRunEvent } from "@teststand/contracts/testing";
import { planOutlineEntries, resultConsoleEntries, resultEvidence, resultSummary } from "./run-format.js";
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

  it("puts measured values and assertions on the console at the end of their step", () => {
    const timeline: RunTimeline = {
      runId: "run", tb0: 1_000, tb1: 2_000, anchors: [], violations: [], marks: [], streams: [], gaps: [], calls: [],
      steps: [{
        executionId: "e1", stepId: "m", stepType: "PublishResult", region: "test", tb0: 1_000, tb1: 1_200,
        verdict: "Pass", durationMs: 200
      }],
      windows: [{
        sequence: 3, stepId: "w", executionId: "e2", type: "observe", key: "k", hardwareId: "h", streamId: "s",
        verdict: "Pass", tb0: 1_300, tb1: 1_400
      }]
    };
    const results: TestResult[] = [
      { sequence: 1, at: "2026-09-18T00:00:00Z", name: "输出电压", kind: "measurement", value: 4.98, unit: "V",
        executionId: "e1", hardwareId: "srv.PCI1710L_CARD" },
      { sequence: 2, at: "2026-09-18T00:00:00Z", name: "电压范围", kind: "assertion", passed: false, actual: 4.98,
        limits: { low: 5, high: 5.5 }, executionId: "e1" },
      verdict({ sequence: 3, executionId: "e2" })
    ];
    const entries = resultConsoleEntries(results, timeline);
    expect(entries.map((entry) => entry.id)).toEqual(["result:1", "result:2"]);
    expect(entries[0]).toMatchObject({
      tb: 1_200, kind: "judge", source: "PCI1710L", hardwareId: "srv.PCI1710L_CARD", text: "输出电压 · 测量 · 4.98 V"
    });
    expect(entries[1]).toMatchObject({ color: "31", tag: "JG" });
    expect(entries[1]?.text).toMatch(/^电压范围 · 断言 · 失败，实际 4.98/);
    expect(resultConsoleEntries(results, undefined)).toEqual([]);
  });
});

describe("plan outline", () => {
  it("lists every step of the plan as a tree with its state, including the ones not reached", () => {
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
    const entries = planOutlineEntries(buildExecutionTrace(plan, events, [], []), (type) => `<${type}>`);
    const plain = entries.map((entry) => `${entry.tag}${entry.text?.replace(/\x1b\[[\d;]*m/g, "")}`);
    expect(plain).toEqual([
      "  测试区（2 项）",
      "✓ ├─ 闭合继电器  <InvokeTool> · 120 ms",
      "▶ └─ 测量组  <Group> · 执行中",
      "○    └─ 读电压  <InvokeTool>",
      "  清理区（1 项）",
      "○ └─ 断开继电器  <InvokeTool>"
    ]);
    expect(entries.map((entry) => entry.outline)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(entries[1]).toMatchObject({ kind: "plan", executionId: "e1" });
    expect(entries[3]?.executionId).toBeUndefined();
  });
});
