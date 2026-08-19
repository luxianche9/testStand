import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestRun } from "@testforge/contracts/orchestration";
import { DownloadIcon, SquareIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import { nodeStatusTone, runStatusTone } from "../../shared/tone.js";
import { Badge, badgeVariantFromTone, Button, EmptyState, Spinner } from "../../shared/ui/index.js";
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

  if (!run) return (
    <aside className="flex h-full min-h-0 flex-col bg-card" aria-label="运行检查器">
      <EmptyState title="选择一条运行记录" body="在表格中点选一行，查看节点摘要与导出。" className="m-auto" />
    </aside>
  );

  const nodes = detail.data?.nodeRuns ?? [];
  const failed = nodes.find((node) => node.status === "failed");
  return <aside className="flex h-full min-h-0 flex-col bg-card" aria-label="运行检查器">
    <div className="px-3.5 pt-3.5 pb-2">
      <h2 className="m-0 text-base font-semibold">{run.taskName}</h2>
      <small className="mt-1 block font-mono text-[11px] break-all text-muted-foreground">{run.runId}</small>
    </div>
    <div className="flex flex-wrap items-center gap-2 px-3.5 pb-2.5">
      <Badge variant={badgeVariantFromTone(runStatusTone(run.status))}>{run.status}</Badge>
      <Button variant="outline" size="sm" disabled={exportPending} onClick={() => onExport(run)}><DownloadIcon />导出</Button>
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={isActiveRun(run)} onClick={() => onDelete(run)}><Trash2Icon />删除</Button>
      {isActiveRun(run) && <Button variant="destructive" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(run.runId)}><SquareIcon />取消运行</Button>}
    </div>
    {cancel.isError && (
      <div className="mx-3.5 mb-2.5 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
        <TriangleAlertIcon className="mt-px size-3.5 flex-none" />
        <span className="min-w-0">{errorMessage(cancel.error)}</span>
      </div>
    )}
    <div className="grid grid-cols-2 gap-2 px-3.5 pb-2.5">
      <div className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">开始<b className="mt-0.5 block text-xs font-medium text-foreground">{formatRunTime(run.startedAt ?? run.createdAt)}</b></div>
      <div className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">结束<b className="mt-0.5 block text-xs font-medium text-foreground">{run.completedAt ? formatRunTime(run.completedAt) : "—"}</b></div>
      <div className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">耗时<b className="mt-0.5 block text-xs font-medium text-foreground">{runDurationText(run)}</b></div>
      <div className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">节点<b className="mt-0.5 block text-xs font-medium text-foreground">{run.summary ? `${run.summary.passedNodes} 通过 · ${run.summary.failedNodes} 失败` : `${nodes.length} 条`}</b></div>
    </div>
    {failed && <p className="mx-3.5 mb-2.5 text-xs text-destructive">失败发生在「{failed.nodeLabel}」{failed.error ? `：${failed.error.message}` : ""}</p>}
    {run.validationIssues?.length ? <p className="mx-3.5 mb-2.5 text-xs text-destructive">预检未通过：{run.validationIssues.map((issue) => issue.message).join("；")}</p> : null}
    <div className="min-h-0 flex-1 overflow-auto">
      {detail.isLoading && <Spinner label="正在加载节点…" className="p-3.5" />}
      {detail.isError && (
        <div className="mx-3.5 my-2.5 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/5 px-3.5 py-2.5 text-xs whitespace-pre-wrap wrap-anywhere text-destructive">
          <TriangleAlertIcon className="mt-px size-3.5 flex-none" />
          <span className="min-w-0">{errorMessage(detail.error)}</span>
        </div>
      )}
      {nodes.map((node, index) => <div className="flex items-center justify-between gap-2 border-t px-3.5 py-1.5 text-xs" key={node.nodeRunId}>
        <span>{index + 1} {node.nodeLabel}{node.completedAt && node.startedAt ? <small className="ml-1 text-muted-foreground"> · {formatDuration(Math.max(0, Date.parse(node.completedAt) - Date.parse(node.startedAt)))}</small> : null}</span>
        <Badge variant={badgeVariantFromTone(nodeStatusTone(node.status))}>{shortNodeStatus(node.status)}</Badge>
      </div>)}
      {detail.data && !nodes.length && <div className="px-3 py-6 text-center text-xs text-muted-foreground">尚无节点记录</div>}
    </div>
    <div className="mt-auto border-t px-3.5 py-3">
      <Button className="w-full" onClick={() => onOpenDetail(run.runId)}>打开完整详情</Button>
    </div>
  </aside>;
}

function shortNodeStatus(status: string): string {
  if (status === "passed") return "ok";
  if (status === "failed") return "fail";
  if (status === "skipped" || status === "cancelled") return "skip";
  return status;
}
