import type { TestRun, TestRunListSortBy } from "@testforge/contracts/orchestration";
import { TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";
import { runStatusTone } from "../../shared/tone.js";
import { Badge, badgeVariantFromTone, cn, Spinner } from "../../shared/ui/index.js";
import { formatRunTime, isActiveRun, nodeCounts, runDurationText, summaryText, type RunListSortDir } from "./logs-model.js";

const COLUMNS: { id: TestRunListSortBy; label: string }[] = [
  { id: "taskName", label: "任务" },
  { id: "status", label: "状态" },
  { id: "createdAt", label: "开始时间" },
  { id: "duration", label: "耗时" },
  { id: "failedNodes", label: "通过 / 失败" }
];

export function RunTable({
  items,
  total,
  loading,
  error,
  warnings,
  selectedRunId,
  sortBy,
  sortDir,
  onSelect,
  onOpenDetail,
  onSort
}: {
  items: TestRun[];
  total: number;
  loading: boolean;
  error: unknown;
  warnings: string[];
  selectedRunId?: string | undefined;
  sortBy: TestRunListSortBy;
  sortDir: RunListSortDir;
  onSelect: (runId: string) => void;
  onOpenDetail: (runId: string) => void;
  onSort: (column: TestRunListSortBy) => void;
}) {
  return <div className="flex min-h-0 flex-1 flex-col">
    {warnings.length > 0 && (
      <div className="mx-3.5 mt-2 flex flex-none items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
        <TriangleAlertIcon className="mt-px size-3.5 flex-none" />
        <span className="min-w-0">{warnings.length} 个日志文件未能读取。<small className="mt-0.5 block max-h-11 overflow-auto">{warnings.join("；")}</small></span>
      </div>
    )}
    <div className="min-h-0 flex-1 overflow-auto">
      {loading && <Spinner label="正在加载运行历史…" className="p-4" />}
      {error ? (
        <div className="m-3.5 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
          <TriangleAlertIcon className="mt-px size-3.5 flex-none" />
          <span className="min-w-0">{errorMessage(error)}</span>
        </div>
      ) : null}
      {!loading && !error && <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="sticky top-0 z-10 w-5 bg-secondary px-2 py-2 text-left text-[11px] font-semibold text-muted-foreground shadow-sm" aria-label="活动" />
            {COLUMNS.map((column) => <th
              key={column.id}
              className="sticky top-0 z-10 bg-secondary px-2.5 py-2 text-left text-[11px] font-semibold text-muted-foreground shadow-sm"
              aria-sort={sortBy === column.id ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            >
              <button type="button" className="inline-flex items-center gap-1" onClick={() => onSort(column.id)}>
                {column.label}
                {sortBy === column.id ? <span aria-hidden="true">{sortDir === "asc" ? "▴" : "▾"}</span> : null}
              </button>
            </th>)}
            <th className="sticky top-0 z-10 bg-secondary px-2.5 py-2 text-left text-[11px] font-semibold text-muted-foreground shadow-sm">摘要</th>
          </tr>
        </thead>
        <tbody>
          {items.map((run) => <tr
            key={run.runId}
            className={cn("cursor-pointer odd:bg-secondary/20 hover:bg-accent/50", selectedRunId === run.runId && "bg-accent")}
            title="双击查看详情"
            onClick={() => onSelect(run.runId)}
            onDoubleClick={() => onOpenDetail(run.runId)}
          >
            <td className="w-5 px-2 py-2 align-middle text-xs">{isActiveRun(run) ? <span className="inline-block size-2 rounded-full bg-primary ring-[3px] ring-primary/20" title="正在运行" /> : null}</td>
            <td className="px-2.5 py-2 align-middle text-xs">{run.taskName}</td>
            <td className="px-2.5 py-2 align-middle text-xs"><Badge variant={badgeVariantFromTone(runStatusTone(run.status))}>{run.status}</Badge></td>
            <td className="px-2.5 py-2 align-middle text-xs text-muted-foreground">{formatRunTime(run.startedAt ?? run.createdAt)}</td>
            <td className="px-2.5 py-2 align-middle text-xs">{runDurationText(run)}</td>
            <td className="px-2.5 py-2 align-middle text-xs">{nodeCounts(run)}</td>
            <td className="px-2.5 py-2 align-middle text-xs text-muted-foreground">{summaryText(run)}</td>
          </tr>)}
        </tbody>
      </table>}
      {!loading && !error && items.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted-foreground">没有符合条件的运行记录。</div>}
    </div>
    <div className="px-3 pt-1 text-[11px] text-muted-foreground">{total ? `${items.length} / ${total}` : ""}</div>
  </div>;
}
