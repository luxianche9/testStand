import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { ArrowRightIcon, CheckIcon, ImageOffIcon, Maximize2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { pinText, resolvePortRef } from "../../lib/hardware.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, cn } from "../../ui/index.js";
import { isTaskActionable, taskStatusLabel, taskTone } from "./wiring-model.js";

type Preview = { url: string; title: string };

/** Operator work order for one wiring or unwiring request: which ports, which pins, and the photo of
 *  each connector. Closing it leaves the request untouched in the wiring page's task sidebar. */
export function WiringTaskModal({ task, hardware, onChanged, onClose }: {
  task: WiringTask; hardware: Hardware[];
  onChanged: () => Promise<void>; onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") =>
      window.hardwareharness.wiring.completeTask(task.wiringTaskId, outcome),
    onSuccess: async () => { await onChanged(); },
    onError: async () => { await onChanged(); }
  });
  const a = resolvePortRef(task.portA, hardware);
  const b = resolvePortRef(task.portB, hardware);
  const actionable = isTaskActionable(task);
  const samePort = task.portA === task.portB;
  const disconnect = task.action === "disconnect";
  // Each port card already says 暂无端口图, so the catalog's missing-photo warnings would only repeat it.
  const warnings = [...new Set(task.warnings)].filter((warning) => !warning.includes("端口图"));
  const instruction = actionable
    ? `请${disconnect ? "断开" : "连接"}${task.pins.length ? "以下针脚" : "以下端口"}，操作后点击「完成」或「未完成」。`
    : "本次任务的端口与针脚记录。";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={disconnect ? "断线任务" : "接线任务"} description={instruction} size="lg">
        <DialogBody className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-3">
            <Badge tone={taskTone(task.status)}>{taskStatusLabel(task.status)}</Badge>
            {task.status === "pending"
              ? <Countdown expiresAt={task.expiresAt} />
              : task.completedAt && (
                <time className="tf-num" dateTime={task.completedAt}>
                  {new Date(task.completedAt).toLocaleString()}
                </time>
              )}
          </div>
          <div className={cn(!samePort && "grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)]")}>
            <PortGuide portRef={task.portA} hardware={hardware} onPreview={setPreview} />
            {!samePort && <>
              <ArrowRightIcon aria-hidden className="hidden size-4 text-fg-3 sm:block" />
              <PortGuide portRef={task.portB} hardware={hardware} onPreview={setPreview} />
            </>}
          </div>
          {task.pins.length > 0 && (
            <div className="overflow-hidden rounded-md border border-line">
              <div className="flex h-7 items-center justify-between bg-surface-0 px-3 text-fg-3">
                <span className="tf-label">{samePort ? "同一端口内的针脚" : "针脚对应"}</span>
                <span className="tf-num text-2xs">{task.pins.length} 对</span>
              </div>
              {task.pins.map((pin, index) => (
                <div
                  key={`${pin.a}-${pin.b}`}
                  className={cn(
                    "grid grid-cols-[20px_minmax(0,1fr)_16px_minmax(0,1fr)] items-center gap-2 border-t border-line",
                    "px-3 py-1.5 text-sm"
                  )}
                >
                  <span className="tf-num text-right text-2xs text-fg-3">{index + 1}</span>
                  <span className="break-words text-fg">{pinText(a.port, pin.a)}</span>
                  <ArrowRightIcon aria-hidden className="size-3.5 text-signal" />
                  <span className="break-words text-fg">{pinText(b.port, pin.b)}</span>
                </div>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="flex items-start gap-2 text-xs text-invalid">
              <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>{warnings.join("；")}</span>
            </div>
          )}
          {task.message && (
            <p role={task.status === "failed" ? "alert" : undefined} className="text-sm break-words text-fail">
              {task.message}
            </p>
          )}
          {complete.isError && (
            <p role="alert" className="text-sm break-words text-fail">{errorMessage(complete.error)}</p>
          )}
        </DialogBody>
        <DialogFooter className="flex-wrap">
          {actionable && <span className="mr-auto text-xs text-fg-3">可关闭，稍后在工位接线右侧的任务栏处理</span>}
          {actionable ? <>
            <Button variant="outline" onClick={() => complete.mutate("rejected")} disabled={complete.isPending}>
              <XIcon />未完成
            </Button>
            <Button variant="primary" onClick={() => complete.mutate("confirmed")} disabled={complete.isPending}>
              <CheckIcon />{complete.isPending ? "正在提交…" : "完成"}
            </Button>
          </> : <Button variant="outline" onClick={onClose}>关闭</Button>}
        </DialogFooter>
      </DialogContent>
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(undefined); }}>
        <DialogContent title={preview?.title ?? "端口全图"} size="xl" className="w-[calc(100vw-96px)]">
          <DialogBody className="min-h-0 bg-surface-0">
            {preview && (
              <img
                src={preview.url}
                alt={preview.title}
                className="mx-auto max-h-[calc(100vh-200px)] max-w-full object-contain"
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

/** One end of the cable: nameplate over the connector photo, which opens full size. */
function PortGuide({ portRef, hardware, onPreview }: {
  portRef: string; hardware: Hardware[]; onPreview: (image: Preview) => void;
}) {
  const { hardware: owner, port } = resolvePortRef(portRef, hardware);
  const assetId = port?.imageAssetId;
  const url = useQuery({
    queryKey: queryKeys.hardwareImage(owner?.hardwareId ?? "", assetId ?? ""),
    queryFn: () => window.hardwareharness.devices.hardwareImageUrl(owner!.hardwareId, assetId!),
    enabled: Boolean(owner && assetId),
    staleTime: Infinity
  });
  const title = `${owner?.label ?? portRef} · ${port?.name ?? "未知端口"}`;
  const placeholder = assetId ? url.isError ? "端口图加载失败" : "正在加载端口图…" : "暂无端口图";
  return (
    <article className="min-w-0 overflow-hidden rounded-md border border-line bg-surface-0">
      <header className="flex h-8 items-center border-b border-line bg-surface-2 px-3">
        <span className="truncate font-mono text-xs text-fg">{title}</span>
      </header>
      {url.data ? (
        <button
          type="button"
          className={cn(
            "group relative grid h-[clamp(96px,24vh,192px)] w-full cursor-zoom-in place-items-center outline-none",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
          )}
          aria-label={`查看全图：${title}`}
          onClick={() => onPreview({ url: url.data!, title })}
        >
          <img className="absolute inset-0 size-full object-contain" src={url.data} alt={title} />
          <span
            className={cn(
              "absolute right-2 bottom-2 rounded-sm border border-line bg-surface-1/90 p-1 text-fg-3",
              "group-hover:text-fg"
            )}
          >
            <Maximize2Icon className="size-3.5" />
          </span>
        </button>
      ) : (
        <div className={cn("grid place-items-center gap-1 px-3 text-xs text-fg-3", assetId ? "h-24" : "h-10")}>
          <span className="flex items-center gap-1.5">
            <ImageOffIcon aria-hidden className="size-3.5" />{placeholder}
          </span>
        </div>
      )}
    </article>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return (
    <span className="tf-num text-run">剩余 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
  );
}
