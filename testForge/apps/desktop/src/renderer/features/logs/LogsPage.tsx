import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestRun, TestRunStatus } from "@testforge/contracts/orchestration";
import { IconAlert, IconDownload, IconRefresh, IconTrash } from "../../shared/icons.js";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import { useProjectDocument } from "../../shared/queries.js";
import { runStatusTone } from "../../shared/tone.js";
import { Badge, Btn, EmptyState, Modal, Spinner } from "../../shared/ui.js";
import { RunDetail } from "../run-logs/index.js";

const PAGE_SIZE = 50;
const STATUSES: TestRunStatus[] = ["running", "cancelling", "passed", "failed", "blocked", "cancelled", "interrupted"];

export function LogsPage() {
  const client = useQueryClient();
  const project = useProjectDocument();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TestRunStatus | "all">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [confirm, setConfirm] = useState<{ kind: "delete"; run: TestRun } | { kind: "clear" }>();

  const queryInput = useMemo(() => ({
    ...(status === "all" ? {} : { statuses: [status] }),
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(from ? { from: localDayBoundary(from, false) } : {}),
    ...(to ? { to: localDayBoundary(to, true) } : {}),
    offset,
    limit: PAGE_SIZE
  }), [from, offset, search, status, to]);
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

  const mutationError = remove.error ?? clear.error ?? exportRun.error;
  return <main className="logs-page">
    <aside className="logs-sidebar">
      <header className="feature-heading"><span><h1>运行日志</h1><small>项目内持久化的测试 Run</small></span><Btn variant="subtle" icon={<IconRefresh size={14} />} aria-label="刷新运行日志" onClick={() => void runs.refetch()} /></header>
      <div className="logs-filters">
        <input className="input" value={search} placeholder="搜索 Run ID、任务或消息" onChange={(event) => { setSearch(event.target.value); setOffset(0); }} />
        <select className="input" value={status} onChange={(event) => { setStatus(event.target.value as TestRunStatus | "all"); setOffset(0); }}>
          <option value="all">全部状态</option>
          {STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <label><span>开始日期</span><input className="input" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setOffset(0); }} /></label>
        <label><span>结束日期</span><input className="input" type="date" value={to} onChange={(event) => { setTo(event.target.value); setOffset(0); }} /></label>
      </div>
      {runs.data?.warnings.length ? <div className="alert logs-warning"><IconAlert size={14} /><span>{runs.data.warnings.length} 个日志文件未能读取。<small>{runs.data.warnings.join("；")}</small></span></div> : null}
      <div className="run-log-list">
        {runs.isLoading && <Spinner label="正在加载运行历史…" />}
        {runs.isError && <div className="alert"><IconAlert size={14} /><span>{errorMessage(runs.error)}</span></div>}
        {runs.data?.items.map((run) => <button key={run.runId} className={selectedRunId === run.runId ? "active" : ""} onClick={() => setSelectedRunId(run.runId)}>
          <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
          <span><strong>{run.taskName}</strong><small>{run.runId.slice(0, 8)} · {new Date(run.createdAt).toLocaleString()}</small><small>{summaryText(run)}</small></span>
        </button>)}
        {runs.data && !runs.data.items.length && <div className="run-log-empty">没有符合条件的运行记录。</div>}
      </div>
      <footer className="logs-pagination">
        <Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Btn>
        <span>{runs.data ? `${Math.min(offset + 1, runs.data.total)}–${Math.min(offset + PAGE_SIZE, runs.data.total)} / ${runs.data.total}` : "—"}</span>
        <Btn disabled={!runs.data || offset + PAGE_SIZE >= runs.data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Btn>
      </footer>
      <Btn variant="danger" icon={<IconTrash size={13} />} disabled={clear.isPending} onClick={() => setConfirm({ kind: "clear" })}>清空已结束记录</Btn>
    </aside>
    <section className="logs-detail-panel">
      {selected ? <>
        <header className="logs-detail-actions">
          <span><strong>{selected.taskName}</strong><small>{selected.runId}</small></span>
          <Btn icon={<IconDownload size={13} />} disabled={exportRun.isPending} onClick={() => exportRun.mutate(selected)}>导出 JSON</Btn>
          <Btn variant="danger" icon={<IconTrash size={13} />} disabled={isActive(selected)} onClick={() => setConfirm({ kind: "delete", run: selected })}>删除</Btn>
        </header>
        {mutationError && <div className="alert"><IconAlert size={14} /><span>{errorMessage(mutationError)}</span></div>}
        <RunDetail key={selected.runId} runId={selected.runId} />
      </> : <EmptyState title="选择一条运行记录" body="可查看节点输入输出、错误与完整事件时间线。" />}
    </section>
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

function localDayBoundary(value: string, end: boolean): string {
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}`).toISOString();
}
function isActive(run: TestRun): boolean { return run.status === "running" || run.status === "cancelling"; }
function summaryText(run: TestRun): string { return run.summary?.message ?? `通过 ${run.summary?.passedNodes ?? 0} · 失败 ${run.summary?.failedNodes ?? 0}`; }
function safeFilename(value: string): string { return value.replace(/[<>:"/\\|?*]+/g, "-").trim() || "run"; }
