import type { HardwareHarnessApplicationsApi, RunRecord, RunStatus } from "@hardwareharness/contracts/applications";

export async function readRunHistory(listRuns: HardwareHarnessApplicationsApi["listRuns"]): Promise<RunRecord[]> {
  const records = new Map<string, RunRecord>();
  for (let offset = 0; ; offset += 1000) {
    const page = await listRuns({ offset, limit: 1000 });
    for (const run of page) records.set(run.runId, run);
    if (page.length < 1000) return [...records.values()];
  }
}

export type RunListSortBy = "name" | "status" | "startedAt" | "duration" | "eventCount";
export type DateRangePreset = "all" | "today" | "7d" | "custom";
export type RunListSortDir = "asc" | "desc";

export const RUN_STATUSES: RunStatus[] = ["running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"];

export function isActiveRun(run: RunRecord): boolean {
  return run.status === "running" || run.status === "cancelling";
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
}

export function runDurationText(run: RunRecord, now = Date.now()): string {
  const start = Date.parse(run.startedAt);
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

export function eventCounts(run: RunRecord): string { return String(run.eventCount); }

export function summaryText(run: RunRecord): string {
  if (run.error) return run.error.message;
  if (run.status === "succeeded") return "流程执行成功";
  if (run.status === "failed") return "运行失败";
  if (isActiveRun(run)) return "正在运行";
  if (run.status === "cancelled") return "已取消";
  return "已中断";
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

export function nextSort(currentBy: RunListSortBy, currentDir: RunListSortDir, clicked: RunListSortBy): { sortBy: RunListSortBy; sortDir: RunListSortDir } {
  if (currentBy !== clicked) {
    return { sortBy: clicked, sortDir: clicked === "name" || clicked === "status" ? "asc" : "desc" };
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
