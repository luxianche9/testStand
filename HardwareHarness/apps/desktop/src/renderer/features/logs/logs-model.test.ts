import { describe, expect, it } from "vitest";
import type { RunRecord } from "@hardwareharness/contracts/applications";
import { dateRangeBounds, formatRunTime, nextSort, readRunHistory, runDurationText, summaryText } from "./logs-model.js";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "RUN1",
    name: "通信握手测试",
    entrypoint: "workflows/main.py", hardwareIds: [], eventCount: 0, sourcePath: "snapshot",
    status: "succeeded",
    inputs: {},
    startedAt: "2026-08-18T05:51:08.000Z",
    ...overrides
  };
}

describe("logs-model", () => {
  it("reads history across backend pages without discarding older runs", async () => {
    const records = Array.from({ length: 1001 }, (_, index) => run({ runId: `R${index}` }));
    const result = await readRunHistory(async (input) => records.slice(input?.offset ?? 0, (input?.offset ?? 0) + (input?.limit ?? 1000)));
    expect(result).toHaveLength(1001);
    expect(result.at(-1)?.runId).toBe("R1000");
  });
  it("formats duration for completed and live runs", () => {
    expect(runDurationText(run({
      status: "succeeded",
      startedAt: "2026-08-18T05:51:08.000Z",
      completedAt: "2026-08-18T05:51:12.210Z"
    }))).toBe("4.21 s");
    expect(runDurationText(run({ startedAt: "invalid" }))).toBe("—");
    expect(runDurationText(run({
      status: "running",
      startedAt: "2026-08-18T05:51:08.000Z"
    }), Date.parse("2026-08-18T05:51:46.000Z"))).toBe("已跑 38.00 s");
  });

  it("prefers summary message and falls back by status", () => {
    expect(summaryText(run({ error: { category: "error", message: "断言失败" } }))).toBe("断言失败");
    expect(summaryText(run({ status: "succeeded" }))).toBe("流程执行成功");
    expect(summaryText(run({ status: "running" }))).toBe("正在运行");
    expect(summaryText(run({ status: "failed" }))).toBe("运行失败");
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
    expect(nextSort("startedAt", "desc", "name")).toEqual({ sortBy: "name", sortDir: "asc" });
    expect(nextSort("name", "asc", "name")).toEqual({ sortBy: "name", sortDir: "desc" });
    expect(nextSort("startedAt", "desc", "startedAt")).toEqual({ sortBy: "startedAt", sortDir: "asc" });
  });
});
