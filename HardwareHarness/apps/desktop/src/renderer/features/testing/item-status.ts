import type { TestItemStatus, TestRunState } from "@hardwareharness/contracts/testing";
import type { Tone } from "../../ui";

const terminal: ReadonlySet<TestRunState> = new Set(["completed", "aborted", "error"]);

export type ItemResultKind = "running" | "pass" | "fail" | "error" | "stale" | "untested" | "other";

/** What the item list shows for one 功能测试项 on the current unit. */
export interface ItemResult {
  kind: ItemResultKind;
  label: string;
  tone: Tone;
  pulse: boolean;
}

export function isItemRunning(item: Pick<TestItemStatus, "state">): boolean {
  return Boolean(item.state && !terminal.has(item.state));
}

export function itemResult(item: TestItemStatus): ItemResult {
  if (isItemRunning(item)) return { kind: "running", label: "运行中", tone: "run", pulse: true };
  if (item.queued) return { kind: "other", label: "排队", tone: "run", pulse: false };
  if (!item.runId || !item.verdict || item.verdict === "NotSet") {
    return { kind: "untested", label: "未测", tone: "neutral", pulse: false };
  }
  if (item.stale) return { kind: "stale", label: "已过期", tone: "invalid", pulse: false };
  switch (item.verdict) {
    case "Pass": return { kind: "pass", label: "PASS", tone: "pass", pulse: false };
    case "Fail": return { kind: "fail", label: "FAIL", tone: "fail", pulse: false };
    case "Error": return { kind: "error", label: "ERROR", tone: "fail", pulse: false };
    case "Aborted": return { kind: "other", label: "中止", tone: "invalid", pulse: false };
    default: return { kind: "other", label: "不确定", tone: "invalid", pulse: false };
  }
}

/** Lamp colour: a plan that cannot run is flagged regardless of its last result. */
export function itemLamp(item: TestItemStatus): { tone: Tone; pulse: boolean } {
  const result = itemResult(item);
  if (item.invalid && result.kind !== "running") return { tone: "invalid", pulse: false };
  return { tone: result.tone, pulse: result.pulse };
}

export interface ItemSummary { pass: number; fail: number; untested: number; stale: number; other: number }

export function summarizeItems(items: TestItemStatus[]): ItemSummary {
  const summary: ItemSummary = { pass: 0, fail: 0, untested: 0, stale: 0, other: 0 };
  for (const item of items) {
    const { kind } = itemResult(item);
    if (kind === "pass") summary.pass += 1;
    else if (kind === "fail" || kind === "error") summary.fail += 1;
    else if (kind === "untested") summary.untested += 1;
    else if (kind === "stale") summary.stale += 1;
    else summary.other += 1;
  }
  return summary;
}

/** Summary segments such as `12 PASS · 1 FAIL · 3 未测`; 已过期 only appears when non-zero. */
export function summarySegments(summary: ItemSummary): Array<{ text: string; tone: Tone }> {
  return [
    { text: `${summary.pass} PASS`, tone: summary.pass ? "pass" : "neutral" },
    { text: `${summary.fail} FAIL`, tone: summary.fail ? "fail" : "neutral" },
    ...(summary.stale ? [{ text: `${summary.stale} 已过期`, tone: "invalid" as const }] : []),
    { text: `${summary.untested} 未测`, tone: "neutral" }
  ];
}

/** Selected plan ids in list order, which is also the batch execution order. */
export function orderedSelection(items: TestItemStatus[], selected: ReadonlySet<string>): string[] {
  return items.filter((item) => selected.has(item.planId)).map((item) => item.planId);
}
