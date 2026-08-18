import type { TestRun, TestRunListSortBy } from "@testforge/contracts/orchestration";
import { IconAlert } from "../../shared/icons.js";
import { errorMessage } from "../../shared/errors.js";
import { runStatusTone } from "../../shared/tone.js";
import { Badge, Spinner } from "../../shared/ui.js";
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
  onSort: (column: TestRunListSortBy) => void;
}) {
  return <div className="logs-table-panel">
    {warnings.length > 0 && <div className="alert logs-warning"><IconAlert size={14} /><span>{warnings.length} 个日志文件未能读取。<small>{warnings.join("；")}</small></span></div>}
    <div className="logs-table-scroll">
      {loading && <Spinner label="正在加载运行历史…" />}
      {error ? <div className="alert"><IconAlert size={14} /><span>{errorMessage(error)}</span></div> : null}
      {!loading && !error && <table className="logs-table">
        <thead>
          <tr>
            <th className="logs-live-col" aria-label="活动" />
            {COLUMNS.map((column) => <th key={column.id} aria-sort={sortBy === column.id ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
              <button type="button" onClick={() => onSort(column.id)}>
                {column.label}
                {sortBy === column.id ? <span aria-hidden="true">{sortDir === "asc" ? "▴" : "▾"}</span> : null}
              </button>
            </th>)}
            <th>摘要</th>
          </tr>
        </thead>
        <tbody>
          {items.map((run) => <tr key={run.runId} className={selectedRunId === run.runId ? "selected" : ""} onClick={() => onSelect(run.runId)}>
            <td className="logs-live-col">{isActiveRun(run) ? <span className="logs-live" title="正在运行" /> : null}</td>
            <td>{run.taskName}</td>
            <td><Badge tone={runStatusTone(run.status)}>{run.status}</Badge></td>
            <td className="muted-copy">{formatRunTime(run.startedAt ?? run.createdAt)}</td>
            <td>{runDurationText(run)}</td>
            <td>{nodeCounts(run)}</td>
            <td className="muted-copy">{summaryText(run)}</td>
          </tr>)}
        </tbody>
      </table>}
      {!loading && !error && items.length === 0 && <div className="run-log-empty">没有符合条件的运行记录。</div>}
    </div>
    <div className="logs-table-count muted-copy">{total ? `${items.length} / ${total}` : ""}</div>
  </div>;
}
