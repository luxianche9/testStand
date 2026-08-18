import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestRun } from "@testforge/contracts/orchestration";
import { IconAlert, IconDownload, IconStop, IconTrash } from "../../shared/icons.js";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import { nodeStatusTone, runStatusTone } from "../../shared/tone.js";
import { Badge, Btn, EmptyState, Spinner } from "../../shared/ui.js";
import { formatDuration, formatRunTime, isActiveRun, runDurationText } from "./logs-model.js";

export function RunInspector({
  run,
  onExport,
  onDelete,
  onOpenDetail,
  exportPending
}: {
  run?: TestRun | undefined;
  onExport: (run: TestRun) => void;
  onDelete: (run: TestRun) => void;
  onOpenDetail: (runId: string) => void;
  exportPending: boolean;
}) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: [...queryKeys.runLogs, "inspector", run?.runId],
    queryFn: () => window.testforge.orchestration.getRun(run!.runId, 0, 0, 200),
    enabled: Boolean(run)
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => window.testforge.orchestration.cancelRun(runId),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.runLogs }); }
  });

  if (!run) return <aside className="logs-inspector" aria-label="运行检查器"><EmptyState title="选择一条运行记录" body="在表格中点选一行，查看节点摘要与导出。" /></aside>;

  const nodes = detail.data?.nodeRuns ?? [];
  const failed = nodes.find((node) => node.status === "failed");
  return <aside className="logs-inspector" aria-label="运行检查器">
    <div className="logs-inspector-head">
      <h2>{run.taskName}</h2>
      <small>{run.runId}</small>
    </div>
    <div className="logs-inspector-actions">
      <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
      <Btn icon={<IconDownload size={13} />} disabled={exportPending} onClick={() => onExport(run)}>导出</Btn>
      <Btn variant="danger" icon={<IconTrash size={13} />} disabled={isActiveRun(run)} onClick={() => onDelete(run)}>删除</Btn>
      {isActiveRun(run) && <Btn variant="danger" icon={<IconStop size={13} />} disabled={cancel.isPending} onClick={() => cancel.mutate(run.runId)}>取消运行</Btn>}
    </div>
    {cancel.isError && <div className="alert logs-warning"><IconAlert size={14} /><span>{errorMessage(cancel.error)}</span></div>}
    <div className="logs-inspector-meta">
      <div>开始<b>{formatRunTime(run.startedAt ?? run.createdAt)}</b></div>
      <div>结束<b>{run.completedAt ? formatRunTime(run.completedAt) : "—"}</b></div>
      <div>耗时<b>{runDurationText(run)}</b></div>
      <div>节点<b>{run.summary ? `${run.summary.passedNodes} 通过 · ${run.summary.failedNodes} 失败` : `${nodes.length} 条`}</b></div>
    </div>
    {failed && <p className="logs-inspector-fail">失败发生在「{failed.nodeLabel}」{failed.error ? `：${failed.error.message}` : ""}</p>}
    {run.validationIssues?.length ? <p className="logs-inspector-fail">预检未通过：{run.validationIssues.map((issue) => issue.message).join("；")}</p> : null}
    <div className="logs-mini-nodes">
      {detail.isLoading && <Spinner label="正在加载节点…" />}
      {detail.isError && <div className="alert logs-warning"><IconAlert size={14} /><span>{errorMessage(detail.error)}</span></div>}
      {nodes.map((node, index) => <div className="logs-mini-node" key={node.nodeRunId}>
        <span>{index + 1} {node.nodeLabel}{node.completedAt && node.startedAt ? <small className="muted-copy"> · {formatDuration(Math.max(0, Date.parse(node.completedAt) - Date.parse(node.startedAt)))}</small> : null}</span>
        <Badge tone={nodeStatusTone(node.status)}>{shortNodeStatus(node.status)}</Badge>
      </div>)}
      {detail.data && !nodes.length && <div className="run-log-empty">尚无节点记录</div>}
    </div>
    <div className="logs-inspector-foot">
      <Btn variant="primary" onClick={() => onOpenDetail(run.runId)}>打开完整详情</Btn>
    </div>
  </aside>;
}

function shortNodeStatus(status: string): string {
  if (status === "passed") return "ok";
  if (status === "failed") return "fail";
  if (status === "skipped" || status === "cancelled") return "skip";
  return status;
}
