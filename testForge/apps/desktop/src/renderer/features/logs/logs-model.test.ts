import { describe, expect, it } from "vitest";
import type { TestRun } from "@testforge/contracts/orchestration";
import { dateRangeBounds, formatRunTime, nextSort, runDurationText, summaryText } from "./logs-model.js";

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: "RUN1",
    taskId: "TASK1",
    taskName: "通信握手测试",
    projectId: "P1",
    status: "passed",
    inputs: {},
    createdAt: "2026-08-18T05:51:08.000Z",
    ...overrides
  };
}

describe("logs-model", () => {
  it("formats duration for completed and live runs", () => {
    expect(runDurationText(run({
      status: "passed",
      startedAt: "2026-08-18T05:51:08.000Z",
      completedAt: "2026-08-18T05:51:12.210Z"
    }))).toBe("4.21 s");
    expect(runDurationText(run({ status: "blocked" }))).toBe("—");
    expect(runDurationText(run({
      status: "running",
      startedAt: "2026-08-18T05:51:08.000Z"
    }), Date.parse("2026-08-18T05:51:46.000Z"))).toBe("已跑 38.00 s");
  });

  it("prefers summary message and falls back by status", () => {
    expect(summaryText(run({ summary: { passedNodes: 5, failedNodes: 1, cancelledNodes: 0, message: "断言失败" } }))).toBe("断言失败");
    expect(summaryText(run({ status: "passed", summary: { passedNodes: 3, failedNodes: 0, cancelledNodes: 0 } }))).toBe("全部节点通过");
    expect(summaryText(run({ status: "running" }))).toBe("正在运行");
    expect(summaryText(run({ status: "failed", summary: { passedNodes: 5, failedNodes: 1, cancelledNodes: 0 } }))).toBe("失败 1 个节点");
  });

  it("shortens timestamps on the same local day", () => {
    const now = new Date(2026, 7, 18, 16, 0, 0);
    const today = new Date(2026, 7, 18, 13, 51, 8).toISOString();
    const yesterday = new Date(2026, 7, 17, 15, 11, 33).toISOString();
    expect(formatRunTime(today, now)).toMatch(/^今天 /);
    expect(formatRunTime(yesterday, now)).toMatch(/^昨天 /);
  });

  it("maps date presets onto inclusive local-day bounds", () => {
    const now = new Date(2026, 7, 18, 16, 0, 0);
    expect(dateRangeBounds("all", "", "", now)).toEqual({});
    expect(dateRangeBounds("today", "", "", now)).toEqual({
      from: new Date(2026, 7, 18, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 7, 18, 23, 59, 59, 999).toISOString()
    });
    expect(dateRangeBounds("7d", "", "", now).from).toBe(new Date(2026, 7, 12, 0, 0, 0, 0).toISOString());
    expect(dateRangeBounds("custom", "2026-08-11", "2026-08-18", now)).toEqual({
      from: new Date("2026-08-11T00:00:00.000").toISOString(),
      to: new Date("2026-08-18T23:59:59.999").toISOString()
    });
  });

  it("toggles sort direction on the same column", () => {
    expect(nextSort("createdAt", "desc", "taskName")).toEqual({ sortBy: "taskName", sortDir: "asc" });
    expect(nextSort("taskName", "asc", "taskName")).toEqual({ sortBy: "taskName", sortDir: "desc" });
    expect(nextSort("createdAt", "desc", "createdAt")).toEqual({ sortBy: "createdAt", sortDir: "asc" });
  });
});
