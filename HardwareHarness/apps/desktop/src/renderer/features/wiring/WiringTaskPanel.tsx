import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { ArrowRightIcon, CheckIcon, Maximize2Icon, TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import { Badge, badgeVariantFromTone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../shared/ui/dialog";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { isTaskActionable, taskStatusLabel, taskTone } from "./wiring-model.js";

export function WiringTaskModal({ task, hardware, onChanged, onClose }: {
  task: WiringTask; hardware: Hardware[];
  onChanged: () => Promise<void>; onClose: () => void;
}) {
  const [preview, setPreview] = useState<{ url: string; title: string }>();
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") => window.hardwareharness.wiring.completeTask(task.wiringTaskId, outcome),
    onSuccess: async () => { await onChanged(); },
    onError: async () => { await onChanged(); }
  });
  const a = resolvePortRef(task.portA, hardware);
  const b = resolvePortRef(task.portB, hardware);
  const actionable = isTaskActionable(task);
  const samePort = task.portA === task.portB;
  const disconnect = task.action === "disconnect";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="lg" aria-describedby="wiring-task-description">
        <DialogHeader className="[&_h2]:m-0" title={disconnect ? "断线任务" : "接线任务"} onClose={onClose} />
        <DialogBody className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <Badge variant={badgeVariantFromTone(taskTone(task.status))}>{taskStatusLabel(task.status)}</Badge>
            {task.status === "pending" ? <Countdown expiresAt={task.expiresAt} />
              : task.completedAt && <time dateTime={task.completedAt}>{new Date(task.completedAt).toLocaleString()}</time>}
          </div>
          <p id="wiring-task-description" className="mb-0 text-sm text-muted-foreground">
            {actionable ? `请${disconnect ? "断开" : "连接"}${task.pins.length ? "以下针脚" : "以下端口"}，操作完成后点击「已完成」。` : "本次任务的端口与针脚记录。"}
          </p>
          <div className={samePort ? "" : "grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)]"}>
            <PortGuide portRef={task.portA} hardware={hardware} onPreview={setPreview} />
            {!samePort && <>
              <ArrowRightIcon className="hidden size-4 text-muted-foreground sm:block" />
              <PortGuide portRef={task.portB} hardware={hardware} onPreview={setPreview} />
            </>}
          </div>
          {task.pins.length > 0 && (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="flex items-center justify-between bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <span>{samePort ? "同一端口内的针脚" : "针脚对应"}</span><span>{task.pins.length} 对</span>
              </div>
              {task.pins.map((pin) => (
                <div key={`${pin.a}-${pin.b}`} className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-center gap-3 px-3 py-2.5 text-sm even:bg-muted/20">
                  <span className="break-words">{pinText(a.port, pin.a)}</span>
                  <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                  <span className="break-words">{pinText(b.port, pin.b)}</span>
                </div>
              ))}
            </div>
          )}
          {task.warnings.length > 0 && <div className="flex items-start gap-2 text-xs text-muted-foreground"><TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" /><span>{[...new Set(task.warnings)].join("；")}</span></div>}
          {task.message && <p role={task.status === "failed" ? "alert" : undefined} className="text-sm break-words text-destructive">{task.message}</p>}
          {complete.isError && <p role="alert" className="text-sm break-words text-destructive">{errorMessage(complete.error)}</p>}
        </DialogBody>
        <DialogFooter className="flex-wrap items-center">
          <span className="mr-auto text-xs text-muted-foreground">可关闭，稍后从信箱打开</span>
          {actionable ? <>
            <Button variant="ghost" onClick={() => complete.mutate("rejected")} disabled={complete.isPending}>无法完成</Button>
            <Button onClick={() => complete.mutate("confirmed")} disabled={complete.isPending}><CheckIcon className="size-4" />{complete.isPending ? "正在提交…" : "已完成"}</Button>
          </> : <Button variant="outline" onClick={onClose}>关闭</Button>}
        </DialogFooter>
      </DialogContent>
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(undefined); }}>
        <DialogContent size="xl" className="w-[calc(100vw-96px)]" aria-describedby={undefined}>
          <DialogHeader title={preview?.title ?? "端口全图"} onClose={() => setPreview(undefined)} />
          <DialogBody className="min-h-0">
            {preview && <img src={preview.url} alt={preview.title} className="mx-auto max-h-[calc(100vh-200px)] max-w-full object-contain" />}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function PortGuide({ portRef, hardware, onPreview }: {
  portRef: string; hardware: Hardware[]; onPreview: (image: { url: string; title: string }) => void;
}) {
  const { hardware: owner, port } = resolvePortRef(portRef, hardware);
  const assetId = port?.imageAssetId;
  const url = useQuery({
    queryKey: queryKeys.hardwareImage(owner?.hardwareId ?? "", assetId ?? ""),
    queryFn: () => window.hardwareharness.devices.hardwareImageUrl(owner!.hardwareId, assetId!),
    enabled: Boolean(owner && assetId), staleTime: Infinity
  });
  const title = `${owner?.label ?? portRef} · ${port?.name ?? "未知端口"}`;
  return (
    <article className="min-w-0 overflow-hidden rounded-md border border-border">
      <header className="px-3 py-2 text-sm font-medium break-words">{title}</header>
      {url.data ? <button type="button" className="group relative grid h-[clamp(96px,24vh,192px)] w-full cursor-zoom-in place-items-center bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-label={`查看全图：${title}`} onClick={() => onPreview({ url: url.data!, title })}>
        <img className="absolute inset-0 h-full w-full object-contain" src={url.data} alt={title} />
        <span className="absolute right-2 bottom-2 rounded bg-background/90 p-1.5 text-muted-foreground shadow-sm group-hover:text-foreground"><Maximize2Icon className="size-3.5" /></span>
      </button> : <div className="grid h-24 place-items-center bg-muted/30 px-3 text-xs text-muted-foreground">{assetId ? url.isError ? "端口图加载失败" : "正在加载端口图…" : "暂无端口图"}</div>}
    </article>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return <span className="tabular-nums">剩余 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>;
}
