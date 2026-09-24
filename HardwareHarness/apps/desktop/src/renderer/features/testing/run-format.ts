import type { TestResult, TestRunEvent, TestRunLog } from "@hardwareharness/contracts/testing";
import type { Tone } from "../../ui";
import type { ExecutionTrace, StepRunState } from "./run-log-model.js";

export type SyncLabel = "实时" | "同步中" | "正在补齐日志" | "历史快照";

export function mergeBySequence<T extends { sequence: number }>(before: T[], after: T[]): T[] {
  const values = new Map(before.map((item) => [item.sequence, item]));
  for (const item of after) values.set(item.sequence, item);
  return [...values.values()].sort((a, b) => a.sequence - b.sequence);
}

export function firstSequenceGap(items: Array<{ sequence: number }>, after: number): string | undefined {
  let expected = after + 1;
  for (const item of items) {
    if (item.sequence !== expected) return `期望 ${expected}，收到 ${item.sequence}`;
    expected += 1;
  }
  return undefined;
}

export function filterEvents(events: TestRunEvent[], filter: string): TestRunEvent[] {
  if (filter === "all") return events;
  if (filter === "step") return events.filter((item) => item.type.startsWith("step."));
  if (filter === "operation") return events.filter((item) => item.type.includes("operation") || item.operationId);
  return events.filter((item) => item.type.includes("error") || item.error);
}

export function activeExecutions(log: TestRunLog, trace: ExecutionTrace): string[] {
  // A finished run keeps its last currentStepId; nothing is "正在执行" any more.
  if (["completed", "aborted", "error"].includes(log.run.state)) return [];
  if (log.run.activeExecutionIds?.length) return log.run.activeExecutionIds;
  const nodes = [...trace.byExecutionId.values()];
  const running = nodes.filter((node) => node.state === "running").map((node) => node.executionId);
  if (running.length) return running;
  if (log.run.currentStepId) {
    return nodes.filter((node) => node.stepId === log.run.currentStepId).slice(-1).map((node) => node.executionId);
  }
  return [];
}

export function firstProblemExecution(log: TestRunLog, trace: ExecutionTrace): string | undefined {
  const failed = log.results.find((item) =>
    item.kind === "assertion" && item.passed === false && typeof item.executionId === "string");
  if (failed?.executionId) return failed.executionId;
  const nodes = [...trace.byExecutionId.values()];
  const problem = nodes.find((node) => node.state === "Fail" || node.state === "Error");
  if (problem) return problem.executionId;
  const errorStep = log.run.primaryError?.stepId;
  return errorStep ? nodes.find((node) => node.stepId === errorStep)?.executionId : undefined;
}

export function formatTime(value: string): string { return new Date(value).toLocaleTimeString(); }

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(6);
}

export function eventDetail(event: TestRunEvent): string {
  if (typeof event.stepId === "string") return event.stepId;
  if (typeof event.operationId === "string") return event.operationId;
  return event.error ? JSON.stringify(event.error) : "";
}

export function friendlyField(field: string): string {
  return field === "value" ? "测量值" : field.replace(/^value\./, "");
}

export function summarizeValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const encoded = JSON.stringify(value);
    return encoded.length > 120 ? `${encoded.slice(0, 117)}...` : encoded;
  } catch {
    return "";
  }
}

/** Judgment limits in instrument notation: `11.5 ~ 12.5`, `5 ± 0.2`, `= 1`; other shapes fall back to JSON. */
export function formatLimits(limits: unknown): string {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return summarizeValue(limits);
  const { minimum, maximum, expected, tolerance, mask, ...rest } = limits as Record<string, unknown>;
  if (Object.keys(rest).length) return summarizeValue(limits);
  const text = (value: unknown) => summarizeValue(value);
  if (minimum !== undefined || maximum !== undefined) {
    return `${minimum === undefined ? "-∞" : text(minimum)} ~ ${maximum === undefined ? "+∞" : text(maximum)}`;
  }
  if (expected !== undefined && tolerance !== undefined) return `${text(expected)} ± ${text(tolerance)}`;
  if (expected !== undefined && mask !== undefined) return `${text(expected)}（掩码 ${text(mask)}）`;
  if (expected !== undefined) return `= ${text(expected)}`;
  return summarizeValue(limits);
}

export function resultSummary(result: TestResult): string {
  if (result.kind === "assertion") {
    const verdict = result.passed === false ? "失败" : "通过";
    const actual = summarizeValue(result.actual);
    const limits = formatLimits(result.limits);
    return [verdict, actual && `实际 ${actual}`, limits && `要求 ${limits}`].filter(Boolean).join("，");
  }
  return typeof result.message === "string" ? result.message : summarizeValue(result.value);
}

export function assertionLimits(assertions: TestResult[]): string {
  const values = assertions.map((item) => formatLimits(item.limits)).filter(Boolean);
  return [...new Set(values)].join("；");
}

const stateLabels: Record<StepRunState, string> = {
  waiting: "等待", running: "运行中", Pass: "通过", Fail: "失败", Error: "错误", skipped: "跳过", Aborted: "已终止"
};
export function stateLabel(value: StepRunState): string { return stateLabels[value]; }

export function stateTone(value: StepRunState): Tone {
  if (value === "running") return "run";
  if (value === "Pass") return "pass";
  if (value === "Fail" || value === "Error") return "fail";
  if (value === "Aborted") return "invalid";
  return "neutral";
}

const resultKindLabels: Record<string, string> = { assertion: "断言", measurement: "测量", observation: "观察", note: "备注" };
export function resultKindLabel(kind: string): string { return resultKindLabels[kind] ?? kind; }

const operationStateLabels: Record<string, string> = {
  accepted: "已接受", dispatched: "已派发", succeeded: "成功", failed: "失败",
  outcome_unknown: "结果未知", recovery_required: "需要恢复"
};
export function operationStateLabel(value: string): string { return operationStateLabels[value] ?? value; }

export function sparkPath(values: number[], width: number, height: number): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
    const y = height - (value - min) / range * (height - 8) - 4;
    return `${index ? "L" : "M"}${x},${y}`;
  }).join(" ");
}

/** Plain-text export of the technical event log. */
export function eventsAsText(log: TestRunLog): string {
  const header = `# ${log.run.planName} · ${log.run.runId}\n# ${log.run.state} · ${log.run.verdict}\n`;
  return header + log.events.map((event) =>
    [event.sequence, event.at, event.type, eventDetail(event)].join("\t")).join("\n") + "\n";
}

/** CSV export of recorded results (measurements, assertions, notes). */
export function resultsAsCsv(log: TestRunLog): string {
  const quote = (value: unknown) => `"${summarizeValue(value).replaceAll("\"", "\"\"")}"`;
  const rows = log.results.map((result) => [
    result.sequence, result.at, result.kind ?? "note", result.name, result.sourceStepId ?? "",
    result.value ?? result.actual ?? "", result.unit ?? "", result.passed ?? "", result.limits ?? ""
  ].map(quote).join(","));
  return ["sequence,at,kind,name,step,value,unit,passed,limits", ...rows].join("\n") + "\n";
}
