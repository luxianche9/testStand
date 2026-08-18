import type { TestRun, TestRunListSortBy, TestRunStatus } from "@testforge/contracts/orchestration";

export type DateRangePreset = "all" | "today" | "7d" | "custom";
export type RunListSortDir = "asc" | "desc";

export const RUN_STATUSES: TestRunStatus[] = ["running", "cancelling", "passed", "failed", "blocked", "cancelled", "interrupted"];

export function isActiveRun(run: TestRun): boolean {
  return run.status === "running" || run.status === "cancelling";
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
}

export function runDurationText(run: TestRun, now = Date.now()): string {
  if (run.status === "blocked" && !run.startedAt && !run.completedAt) return "—";
  const start = Date.parse(run.startedAt ?? run.createdAt);
  if (!Number.isFinite(start)) return "—";
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  const text = formatDuration(Math.max(0, end - start));
  return isActiveRun(run) ? `已跑 ${text}` : text;
}

export function formatRunTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString();
  if (sameLocalDay(date, now)) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(date, yesterday)) return `昨天 ${time}`;
  return date.toLocaleString();
}

export function nodeCounts(run: TestRun): string {
  if (!run.summary) return "—";
  return `${run.summary.passedNodes} / ${run.summary.failedNodes}`;
}

export function summaryText(run: TestRun): string {
  if (run.summary?.message) return run.summary.message;
  if (run.status === "passed") return "全部节点通过";
  if (run.status === "failed") return run.summary ? `失败 ${run.summary.failedNodes} 个节点` : "运行失败";
  if (run.status === "running" || run.status === "cancelling") return "正在运行";
  if (run.status === "blocked") return "已阻塞";
  if (run.status === "cancelled") return "已取消";
  if (run.status === "interrupted") return "已中断";
  return "—";
}

export function dateRangeBounds(preset: DateRangePreset, from = "", to = "", now = new Date()): { from?: string; to?: string } {
  if (preset === "all") return {};
  if (preset === "custom") {
    return {
      ...(from ? { from: localDayBoundary(from, false) } : {}),
      ...(to ? { to: localDayBoundary(to, true) } : {})
    };
  }
  if (preset === "today") {
    return { from: startOfLocalDay(now).toISOString(), to: endOfLocalDay(now).toISOString() };
  }
  const start = startOfLocalDay(now);
  start.setDate(start.getDate() - 6);
  return { from: start.toISOString(), to: endOfLocalDay(now).toISOString() };
}

export function nextSort(currentBy: TestRunListSortBy, currentDir: RunListSortDir, clicked: TestRunListSortBy): { sortBy: TestRunListSortBy; sortDir: RunListSortDir } {
  if (currentBy !== clicked) {
    return { sortBy: clicked, sortDir: clicked === "taskName" || clicked === "status" ? "asc" : "desc" };
  }
  return { sortBy: clicked, sortDir: currentDir === "asc" ? "desc" : "asc" };
}

function localDayBoundary(value: string, end: boolean): string {
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}`).toISOString();
}

export function safeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*]+/g, "-").trim() || "run";
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}
