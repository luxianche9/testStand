import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestRun, TestRunListSortBy, TestRunStatus } from "@testforge/contracts/orchestration";
import { DownloadIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import { useProjectDocument } from "../../shared/queries.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Input, Select } from "../../shared/ui/index.js";
import { FeatureLayout, FeatureHeader } from "../../shared/FeatureLayout.js";
import { RunDetail } from "../run-logs/index.js";
import { dateRangeBounds, isActiveRun, nextSort, RUN_STATUSES, safeFilename, type DateRangePreset, type RunListSortDir } from "./logs-model.js";
import { RunTable } from "./RunTable.js";

const PAGE_SIZE = 50;

export function LogsPage() {
  const client = useQueryClient();
  const project = useProjectDocument();
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
    if (selectedRunId && !items.some((run) => run.runId === selectedRunId)) setSelectedRunId(undefined);
    if (detailRunId && !items.some((run) => run.runId === detailRunId)) setDetailRunId(undefined);
  }, [detailRunId, runs.data?.items, selectedRunId]);

  const taskNameOptions = useMemo(() => (runs.data?.taskNames ?? []).map((name) => <option key={name} value={name}>{name}</option>), [runs.data?.taskNames]);
  const statusOptions = useMemo(() => RUN_STATUSES.map((item) => <option key={item} value={item}>{item}</option>), []);
  const detailRun = runs.data?.items.find((run) => run.runId === detailRunId);
  const resetPaging = () => setOffset(0);
  const remove = useMutation({
    mutationFn: (runId: string) => window.testforge.orchestration.deleteRun(runId),
    onSuccess: async () => {
      setConfirm(undefined);
      setSelectedRunId(undefined);
      setDetailRunId(undefined);
      await client.invalidateQueries({ queryKey: queryKeys.runLogs });
    }
  });
  const clear = useMutation({
    mutationFn: () => window.testforge.orchestration.clearCompletedRuns(),
    onSuccess: async () => {
      setConfirm(undefined);
      setSelectedRunId(undefined);
      setDetailRunId(undefined);
      await client.invalidateQueries({ queryKey: queryKeys.runLogs });
    }
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

  const openDetail = (runId: string) => {
    setSelectedRunId(runId);
    setDetailRunId(runId);
  };

  const mutationError = remove.error ?? clear.error ?? exportRun.error ?? exportFiltered.error;
  return <FeatureLayout
    header={
      <FeatureHeader
        title="运行日志"
        actions={
          <>
            <Button variant="outline" size="sm" disabled={exportFiltered.isPending || !runs.data?.items.length} onClick={() => exportFiltered.mutate()}><DownloadIcon />导出当前筛选</Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={clear.isPending} onClick={() => setConfirm({ kind: "clear" })}><Trash2Icon />清空已结束</Button>
          </>
        }
      >
        <Input className="w-56" value={search} placeholder="搜索任务 / Run ID" aria-label="搜索运行日志" onChange={(event) => { setSearch(event.target.value); resetPaging(); }} />
        <Select className="w-auto" aria-label="按任务筛选" value={taskName} onChange={(event) => { setTaskName(event.target.value); resetPaging(); }}>
          <option value="all">全部任务</option>
          {taskNameOptions}
        </Select>
        <Select className="w-auto" aria-label="按状态筛选" value={status} onChange={(event) => { setStatus(event.target.value as TestRunStatus | "all"); resetPaging(); }}>
          <option value="all">全部状态</option>
          {statusOptions}
        </Select>
        <Select className="w-auto" aria-label="时间范围" value={range} onChange={(event) => { setRange(event.target.value as DateRangePreset); resetPaging(); }}>
          <option value="all">全部时间</option>
          <option value="today">今天</option>
          <option value="7d">最近 7 天</option>
          <option value="custom">自定义</option>
        </Select>
        {range === "custom" && <span className="flex gap-1.5">
          <Input type="date" aria-label="开始日期" value={from} onChange={(event) => { setFrom(event.target.value); resetPaging(); }} />
          <Input type="date" aria-label="结束日期" value={to} onChange={(event) => { setTo(event.target.value); resetPaging(); }} />
        </span>}
        <Button variant="ghost" size="icon-sm" aria-label="刷新运行日志" onClick={() => void runs.refetch()}><RefreshCwIcon /></Button>
      </FeatureHeader>
    }
  >
    {mutationError && (
      <div className="mx-3.5 mt-2 flex flex-none items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
        <TriangleAlertIcon className="mt-px size-3.5 flex-none" />
        <span className="min-w-0">{errorMessage(mutationError)}</span>
      </div>
    )}
    <div className="flex min-h-0 flex-1 flex-col">
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
        onOpenDetail={openDetail}
        onSort={(column) => {
          const next = nextSort(sortBy, sortDir, column);
          setSortBy(next.sortBy);
          setSortDir(next.sortDir);
          resetPaging();
        }}
      />
      <footer className="grid flex-none grid-cols-[auto_1fr_auto] items-center gap-1.5 bg-secondary/40 px-3 py-2">
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
        <span className="text-center text-xs text-muted-foreground">{runs.data ? `${Math.min(offset + 1, runs.data.total)}–${Math.min(offset + PAGE_SIZE, runs.data.total)} / ${runs.data.total}` : "—"}</span>
        <Button variant="outline" size="sm" disabled={!runs.data || offset + PAGE_SIZE >= runs.data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button>
      </footer>
    </div>
    <Dialog open={Boolean(detailRunId)} onOpenChange={(open) => { if (!open) setDetailRunId(undefined); }}>
      <DialogContent size="lg" aria-label="运行详情">
        <DialogHeader title="运行详情" onClose={() => setDetailRunId(undefined)} />
        <DialogBody>{detailRunId && <RunDetail key={detailRunId} runId={detailRunId} />}</DialogBody>
        {detailRun && <DialogFooter>
          <Button variant="outline" disabled={exportRun.isPending} onClick={() => exportRun.mutate(detailRun)}><DownloadIcon />导出</Button>
          <Button variant="destructive" disabled={isActiveRun(detailRun)} onClick={() => setConfirm({ kind: "delete", run: detailRun })}><Trash2Icon />删除</Button>
        </DialogFooter>}
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(undefined); }}>
      <DialogContent size="sm" aria-label={confirm?.kind === "delete" ? "删除运行日志" : "清空已结束日志"}>
        <DialogHeader title={confirm?.kind === "delete" ? "删除运行日志" : "清空已结束日志"} onClose={() => setConfirm(undefined)} />
        <DialogBody>
          <p className="m-0 text-sm">{confirm?.kind === "delete" ? `将永久删除 Run ${confirm.run.runId} 的项目日志。` : "将永久删除当前工程内全部已结束、已阻塞、已取消和已中断的 Run 日志；活动 Run 不受影响。"}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirm(undefined)}>取消</Button>
          <Button variant="destructive" disabled={remove.isPending || clear.isPending} onClick={() => {
            if (confirm?.kind === "delete") remove.mutate(confirm.run.runId);
            else if (confirm?.kind === "clear") clear.mutate();
          }}>确认删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </FeatureLayout>;
}
