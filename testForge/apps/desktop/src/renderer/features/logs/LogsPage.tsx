import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestRun, TestRunListSortBy, TestRunStatus } from "@testforge/contracts/orchestration";
import { IconAlert, IconDownload, IconRefresh, IconTrash } from "../../shared/icons.js";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import { useProjectDocument } from "../../shared/queries.js";
import { useResizableWidth } from "../../shared/resizable.js";
import { Btn, Modal } from "../../shared/ui.js";
import { RunDetail } from "../run-logs/index.js";
import { dateRangeBounds, nextSort, RUN_STATUSES, safeFilename, type DateRangePreset, type RunListSortDir } from "./logs-model.js";
import { RunInspector } from "./RunInspector.js";
import { RunTable } from "./RunTable.js";

const PAGE_SIZE = 50;

export function LogsPage() {
  const client = useQueryClient();
  const project = useProjectDocument();
  const inspector = useResizableWidth({ defaultWidth: 360, min: 280, max: 520, direction: "left" });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TestRunStatus | "all">("all");
  const [taskName, setTaskName] = useState("all");
  const [range, setRange] = useState<DateRangePreset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sortBy, setSortBy] = useState<TestRunListSortBy>("createdAt");
  const [sortDir, setSortDir] = useState<RunListSortDir>("desc");
  const [offset, setOffset] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [detailRunId, setDetailRunId] = useState<string>();
  const [confirm, setConfirm] = useState<{ kind: "delete"; run: TestRun } | { kind: "clear" }>();

  const bounds = useMemo(() => dateRangeBounds(range, from, to), [from, range, to]);
  const queryInput = useMemo(() => ({
    ...(status === "all" ? {} : { statuses: [status] }),
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(taskName === "all" ? {} : { taskName }),
    ...bounds,
    sortBy,
    sortDir,
    offset,
    limit: PAGE_SIZE
  }), [bounds, offset, search, sortBy, sortDir, status, taskName]);
  const runs = useQuery({ queryKey: queryKeys.runLogList(project.data?.file.projectId, queryInput), queryFn: () => window.testforge.orchestration.listRuns(queryInput) });

  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.runLogs }); };
    const stopRun = window.testforge.events.subscribe("run", refresh);
    const stopNode = window.testforge.events.subscribe("nodeRun", refresh);
    const fallback = window.setInterval(refresh, 10_000);
    return () => { stopRun(); stopNode(); window.clearInterval(fallback); };
  }, [client]);

  useEffect(() => {
    const items = runs.data?.items ?? [];
    if (!items.length) { setSelectedRunId(undefined); return; }
    if (!selectedRunId || !items.some((run) => run.runId === selectedRunId)) setSelectedRunId(items[0]!.runId);
  }, [runs.data?.items, selectedRunId]);

  const selected = runs.data?.items.find((run) => run.runId === selectedRunId);
  const resetPaging = () => setOffset(0);
  const remove = useMutation({
    mutationFn: (runId: string) => window.testforge.orchestration.deleteRun(runId),
    onSuccess: async () => { setConfirm(undefined); setSelectedRunId(undefined); await client.invalidateQueries({ queryKey: queryKeys.runLogs }); }
  });
  const clear = useMutation({
    mutationFn: () => window.testforge.orchestration.clearCompletedRuns(),
    onSuccess: async () => { setConfirm(undefined); setSelectedRunId(undefined); await client.invalidateQueries({ queryKey: queryKeys.runLogs }); }
  });
  const exportRun = useMutation({
    mutationFn: async (run: TestRun) => {
      const archive = await window.testforge.orchestration.exportRun(run.runId);
      return await window.testforge.system.exportText(
        `${safeFilename(run.taskName)}-${run.runId.slice(0, 8)}.json`,
        `${JSON.stringify(archive, null, 2)}\n`
      );
    }
  });
  const exportFiltered = useMutation({
    mutationFn: async () => {
      const result = await window.testforge.orchestration.listRuns({ ...queryInput, offset: 0, limit: 200 });
      return await window.testforge.system.exportText(
        `runs-filtered.json`,
        `${JSON.stringify(result.items, null, 2)}\n`
      );
    }
  });

  const mutationError = remove.error ?? clear.error ?? exportRun.error ?? exportFiltered.error;
  return <main className="logs-page">
    <div className="logs-toolbar">
      <h1>运行日志</h1>
      <input className="input logs-search" value={search} placeholder="搜索任务 / Run ID" aria-label="搜索运行日志" onChange={(event) => { setSearch(event.target.value); resetPaging(); }} />
      <select className="input" aria-label="按任务筛选" value={taskName} onChange={(event) => { setTaskName(event.target.value); resetPaging(); }}>
        <option value="all">全部任务</option>
        {(runs.data?.taskNames ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select className="input" aria-label="按状态筛选" value={status} onChange={(event) => { setStatus(event.target.value as TestRunStatus | "all"); resetPaging(); }}>
        <option value="all">全部状态</option>
        {RUN_STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <select className="input" aria-label="时间范围" value={range} onChange={(event) => { setRange(event.target.value as DateRangePreset); resetPaging(); }}>
        <option value="all">全部时间</option>
        <option value="today">今天</option>
        <option value="7d">最近 7 天</option>
        <option value="custom">自定义</option>
      </select>
      {range === "custom" && <span className="logs-custom-dates">
        <input className="input" type="date" aria-label="开始日期" value={from} onChange={(event) => { setFrom(event.target.value); resetPaging(); }} />
        <input className="input" type="date" aria-label="结束日期" value={to} onChange={(event) => { setTo(event.target.value); resetPaging(); }} />
      </span>}
      <Btn variant="subtle" icon={<IconRefresh size={14} />} aria-label="刷新运行日志" onClick={() => void runs.refetch()} />
      <span className="logs-toolbar-spacer" />
      <Btn icon={<IconDownload size={13} />} disabled={exportFiltered.isPending || !runs.data?.items.length} onClick={() => exportFiltered.mutate()}>导出当前筛选</Btn>
      <Btn variant="danger" icon={<IconTrash size={13} />} disabled={clear.isPending} onClick={() => setConfirm({ kind: "clear" })}>清空已结束</Btn>
    </div>
    {mutationError && <div className="alert logs-warning"><IconAlert size={14} /><span>{errorMessage(mutationError)}</span></div>}
    <div className="logs-body">
      <div className="logs-table-column">
        <RunTable
          items={runs.data?.items ?? []}
          total={runs.data?.total ?? 0}
          loading={runs.isLoading}
          error={runs.error}
          warnings={runs.data?.warnings ?? []}
          selectedRunId={selectedRunId}
          sortBy={sortBy}
          sortDir={sortDir}
          onSelect={setSelectedRunId}
          onSort={(column) => {
            const next = nextSort(sortBy, sortDir, column);
            setSortBy(next.sortBy);
            setSortDir(next.sortDir);
            resetPaging();
          }}
        />
        <footer className="logs-pagination">
          <Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Btn>
          <span>{runs.data ? `${Math.min(offset + 1, runs.data.total)}–${Math.min(offset + PAGE_SIZE, runs.data.total)} / ${runs.data.total}` : "—"}</span>
          <Btn disabled={!runs.data || offset + PAGE_SIZE >= runs.data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Btn>
        </footer>
      </div>
      <div className="col-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整检查器宽度" title="拖拽调整宽度" {...inspector.handleProps} />
      <div className="logs-inspector-shell" style={{ width: inspector.width }}>
        <RunInspector
          run={selected}
          exportPending={exportRun.isPending}
          onExport={(item) => exportRun.mutate(item)}
          onDelete={(item) => setConfirm({ kind: "delete", run: item })}
          onOpenDetail={setDetailRunId}
        />
      </div>
    </div>
    <Modal open={Boolean(detailRunId)} onClose={() => setDetailRunId(undefined)} title="运行详情" width={760}>
      {detailRunId && <RunDetail key={detailRunId} runId={detailRunId} />}
    </Modal>
    <Modal
      open={Boolean(confirm)}
      onClose={() => setConfirm(undefined)}
      title={confirm?.kind === "delete" ? "删除运行日志" : "清空已结束日志"}
      footer={<><Btn onClick={() => setConfirm(undefined)}>取消</Btn><Btn variant="danger" disabled={remove.isPending || clear.isPending} onClick={() => {
        if (confirm?.kind === "delete") remove.mutate(confirm.run.runId);
        else if (confirm?.kind === "clear") clear.mutate();
      }}>确认删除</Btn></>}
    >
      <p>{confirm?.kind === "delete" ? `将永久删除 Run ${confirm.run.runId} 的项目日志。` : "将永久删除当前工程内全部已结束、已阻塞、已取消和已中断的 Run 日志；活动 Run 不受影响。"}</p>
    </Modal>
  </main>;
}
