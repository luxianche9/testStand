import type { TestResult, TestRunEvent, TestRunLog } from "@teststand/contracts/testing";
import type { TestStep } from "@teststand/contracts/testing";
import type { ExecutionTrace, ExecutionTraceNode } from "./run-log-model.js";

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

function eventDetail(event: TestRunEvent): string {
  if (typeof event.stepId === "string") return event.stepId;
  if (typeof event.operationId === "string") return event.operationId;
  return event.error ? JSON.stringify(event.error) : "";
}

function summarizeValue(value: unknown): string {
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
function formatLimits(limits: unknown): string {
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
  if (result.kind === "verdict") return verdictSummary(result);
  return typeof result.message === "string" ? result.message : summarizeValue(result.value);
}

const VERDICT_LABEL: Record<string, string> = { Pass: "通过", Fail: "失败", Inconclusive: "无法判定", Error: "错误" };
const OPERATOR_TEXT: Record<string, string> = {
  ge: "≥", gte: "≥", le: "≤", lte: "≤", gt: ">", lt: "<", eq: "=", ne: "≠", within: "∈"
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A stream verdict (Observe / Expect / Guard) in one line: the verdict, then what decided it —
 * each metric against its limit, the match latency, or the violation.
 */
function verdictSummary(result: TestResult): string {
  const verdict = String(result.verdict ?? "");
  const evidence = record(result.evidence);
  const label = VERDICT_LABEL[verdict] ?? verdict;
  const text = (value: unknown): string => {
    if (typeof value === "number") return String(+value.toPrecision(6));
    if (Array.isArray(value)) return `[${value.map(text).join(", ")}]`;
    return summarizeValue(value);
  };
  const detail = [evidence.reason, evidence.message].filter((item) => typeof item === "string" && item).join("：");
  if (verdict === "Inconclusive") return [label, detail].filter(Boolean).join("，");
  const assertions = Array.isArray(evidence.assertions) ? evidence.assertions.map(record) : [];
  if (assertions.length) {
    const parts = assertions.map((item) => {
      const operator = OPERATOR_TEXT[String(item.op)] ?? String(item.op ?? "");
      return `${String(item.metric)} ${text(item.actual)} ${operator} ${text(item.value)} ${item.passed ? "✓" : "✗"}`;
    });
    return [label, ...parts].join("，");
  }
  if (result.stepType === "Guard") {
    const violation = evidence.violation;
    return [label, violation ? `越限 ${summarizeValue(violation)}` : "全程未越限"].join("，");
  }
  if (typeof evidence.latencyMs === "number") {
    return [label, `窗口内 ${Math.round(evidence.latencyMs)} ms 满足`].join("，");
  }
  return [label, detail].filter(Boolean).join("，");
}

const resultKindLabels: Record<string, string> = {
  assertion: "断言", measurement: "测量", observation: "观察", note: "备注", verdict: "判定"
};
function resultKindLabel(kind: string): string { return resultKindLabels[kind] ?? kind; }

/** Evidence grades (design §7.7); S is display only and never decides a verdict. */
const evidenceLabels: Record<string, string> = {
  T1: "独立测量", T2: "仪器自测", T3: "仪器精密结果", P: "DUT 协议回报", M: "人工判定", S: "设定值影子，不能作为判定证据"
};
/** A result's evidence grade (verdicts before B14 carry it only in ``evidence``). */
export function resultEvidence(result: TestResult): { grade: string; label: string } | undefined {
  const grade = result.evidenceType ?? record(result.evidence).evidenceType;
  if (typeof grade !== "string" || !(grade in evidenceLabels)) return undefined;
  return { grade, label: evidenceLabels[grade]! };
}

const operationStateLabels: Record<string, string> = {
  accepted: "已接受", dispatched: "已派发", succeeded: "成功", failed: "失败",
  outcome_unknown: "结果未知", recovery_required: "需要恢复"
};
export function operationStateLabel(value: string): string { return operationStateLabels[value] ?? value; }

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

/**
 * The children of a step as the flow shows them: those of its current loop iteration or retry
 * attempt, or the ones it ran; a step not reached yet still lists what it contains.
 */
export function flowChildren(node: ExecutionTraceNode): ExecutionTraceNode[] {
  const current = (node.iterations.length ? node.iterations : node.attempts).at(-1);
  if (current) return current.children;
  return node.children.length ? node.children : pendingChildren(node);
}

/** A step not reached yet still lists what it contains. */
function pendingChildren(node: ExecutionTraceNode): ExecutionTraceNode[] {
  if (!node.pending) return [];
  return (node.step.children ?? []).map((step: TestStep, index: number) => ({
    ...node, executionId: `${node.executionId}/${index}`, stepId: step.id, step, children: [], iterations: [],
    attempts: [], results: [], relatedAssertions: [], operations: [], state: "waiting", pending: true
  }));
}

export function durationText(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}
