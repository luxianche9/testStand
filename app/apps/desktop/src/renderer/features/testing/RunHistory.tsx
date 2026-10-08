import { useEffect, useMemo, useState } from "react";
import type { TestRunListInput, TestRunSummary } from "@teststand/contracts/testing";
import { Button, cn, EmptyState, Input, Select, Spinner, toneText, verdictLabels, verdictTone } from "../../ui";
import { useTestRuns } from "../../lib/queries.js";
import { mergeRuns } from "./plan-helpers.js";

const verdicts = ["Pass", "Fail", "Error", "Aborted", "Inconclusive", "NotSet"] as const;
const states = ["running", "paused", "cleaning", "completed", "aborted", "error"] as const;
const pageSize = 50;
const runStateLabels: Record<TestRunSummary["state"], string> = {
  starting: "启动中", running: "运行中", paused: "已暂停", cleaning: "清理中",
  completed: "已完成", aborted: "已终止", error: "出错"
};

type Filters = Omit<TestRunListInput, "cursor" | "limit">;

/** 运行记录 panel: paginated run history of the project, filtered by verdict, state and date. */
export function RunHistory({ selectedRunId, onOpenRun }: {
  selectedRunId: string | undefined;
  onOpenRun: (runId: string) => void;
}) {
  const [filters, setFilters] = useState<Filters>({});
  const [cursor, setCursor] = useState<string>();
  const [items, setItems] = useState<TestRunSummary[]>([]);
  const filterKey = JSON.stringify(filters);
  useEffect(() => { setCursor(undefined); setItems([]); }, [filterKey]);
  const input = useMemo<TestRunListInput>(
    () => ({ ...filters, limit: pageSize, ...(cursor ? { cursor } : {}) }),
    [cursor, filters]
  );
  const runs = useTestRuns(input);
  useEffect(() => {
    if (!runs.data) return;
    const page = runs.data.items;
    setItems((current) => cursor ? mergeRuns(current, page) : page);
  }, [cursor, runs.data]);
  const change = (patch: Filters) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="grid grid-cols-2 gap-1.5 border-b border-line p-2">
        <Select
          aria-label="按判定筛选"
          value={filters.verdict ?? ""}
          onChange={(event) => change({ verdict: (event.target.value || undefined) as Filters["verdict"] })}
        >
          <option value="">全部判定</option>
          {verdicts.map((item) => <option key={item} value={item}>{verdictLabels[item]}</option>)}
        </Select>
        <Select
          aria-label="按状态筛选"
          value={filters.state ?? ""}
          onChange={(event) => change({ state: (event.target.value || undefined) as Filters["state"] })}
        >
          <option value="">全部状态</option>
          {states.map((item) => <option key={item} value={item}>{runStateLabels[item]}</option>)}
        </Select>
        <Input
          aria-label="起始日期"
          className="col-span-2"
          type="date"
          value={filters.from?.slice(0, 10) ?? ""}
          onChange={(event) => change({ from: event.target.value ? `${event.target.value}T00:00:00` : undefined })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.isLoading && !items.length ? (
          <div className="grid min-h-24 place-items-center"><Spinner label="正在读取运行记录…" /></div>
        ) : !items.length ? (
          <EmptyState compact title="没有运行记录" description="运行测试流程后，历史记录会出现在这里。" />
        ) : (
          <ul aria-label="运行记录">
            {items.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                selected={run.runId === selectedRunId}
                onOpen={() => onOpenRun(run.runId)}
              />
            ))}
          </ul>
        )}
        {runs.data?.nextCursor && (
          <div className="p-2">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => setCursor(runs.data?.nextCursor)}
            >
              加载更多
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, selected, onOpen }: { run: TestRunSummary; selected: boolean; onOpen: () => void }) {
  const tone = verdictTone(run.verdict);
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className={cn(
          "grid w-full gap-0.5 border-b border-line px-3 py-1.5 text-left hover:bg-surface-2",
          selected && "bg-surface-2"
        )}
        onClick={onOpen}
      >
        <span className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-fg">{run.planName}</span>
          {run.features && run.features.length > 0 && (
            <span className="shrink-0 text-2xs text-fg-3">{run.features.length} 个功能组</span>
          )}
          <span className={cn("font-mono text-2xs font-medium", toneText[tone])}>{verdictLabels[run.verdict]}</span>
        </span>
        <span className="flex justify-between gap-2 text-2xs text-fg-3">
          <span className="tf-num">{new Date(run.startedAt).toLocaleString()}</span>
          <span>{runStateLabels[run.state]}</span>
        </span>
      </button>
    </li>
  );
}
