import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { ArrowRightIcon, CableIcon, CheckIcon, ImageOffIcon, UnplugIcon, XIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { pinText, resolvePortRef } from "../../lib/hardware.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Badge, Button, ImageViewer, cn } from "../../ui/index.js";
import { isTaskActionable, taskStatusLabel, taskTone } from "./wiring-model.js";

type Preview = { url: string; title: string };

/** Compact work order for one wiring request: both connector photos, the pin map and the operator's answer.
 *  Embedded in the agent conversation (and the wiring log); photos open in a zoom / rotate viewer. */
export function WiringTaskCard({ task, hardware, onChanged, className }: {
  task: WiringTask;
  hardware: Hardware[];
  onChanged?: () => Promise<void> | void;
  className?: string;
}) {
  const [preview, setPreview] = useState<Preview>();
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") =>
      window.hardwareharness.wiring.completeTask(task.wiringTaskId, outcome),
    onSettled: async () => { await onChanged?.(); }
  });
  const a = resolvePortRef(task.portA, hardware);
  const b = resolvePortRef(task.portB, hardware);
  const actionable = isTaskActionable(task);
  const samePort = task.portA === task.portB;
  const disconnect = task.action === "disconnect";
  // Each endpoint already says 无端口图, so the catalog's missing-photo warnings would only repeat it.
  const warnings = [...new Set(task.warnings)].filter((warning) => !warning.includes("端口图"));
  const tone = taskTone(task.status);
  return (
    <section
      aria-label={disconnect ? "断线任务" : "接线任务"}
      className={cn(
        "relative grid gap-2 overflow-hidden rounded-md border bg-surface-0/40 p-2.5 text-xs",
        actionable ? "border-signal/45" : "border-line",
        className
      )}
    >
      {actionable && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      <header className="flex min-w-0 items-center gap-2">
        {disconnect
          ? <UnplugIcon aria-hidden className="size-4 shrink-0 text-signal" />
          : <CableIcon aria-hidden className="size-4 shrink-0 text-signal" />}
        <h3 className="text-sm font-medium text-fg">{disconnect ? "请断开线缆" : "请连接线缆"}</h3>
        <Badge tone={tone} className="ml-auto">{taskStatusLabel(task.status)}</Badge>
        {task.status === "pending" && <Countdown expiresAt={task.expiresAt} />}
      </header>
      <div className={cn("grid items-center gap-2", !samePort && "grid-cols-[minmax(0,1fr)_14px_minmax(0,1fr)]")}>
        <Endpoint portRef={task.portA} hardware={hardware} onPreview={setPreview} />
        {!samePort && <>
          <ArrowRightIcon aria-hidden className="size-3.5 text-fg-3" />
          <Endpoint portRef={task.portB} hardware={hardware} onPreview={setPreview} />
        </>}
      </div>
      {task.pins.length > 0 && (
        <ol aria-label="针脚对应" className="grid gap-px rounded-sm border border-line bg-line">
          {task.pins.map((pin, index) => (
            <li
              key={`${pin.a}-${pin.b}`}
              className={cn(
                "grid grid-cols-[16px_minmax(0,1fr)_12px_minmax(0,1fr)] items-center gap-1.5",
                "bg-surface-0 px-2 py-1"
              )}
            >
              <span className="tf-num text-right text-2xs text-fg-3">{index + 1}</span>
              <span className="break-words text-fg">{pinText(a.port, pin.a)}</span>
              <ArrowRightIcon aria-hidden className="size-3 text-signal" />
              <span className="break-words text-fg">{pinText(b.port, pin.b)}</span>
            </li>
          ))}
        </ol>
      )}
      {warnings.length > 0 && <p className="text-invalid">{warnings.join("；")}</p>}
      {task.message && (
        <p role={task.status === "failed" ? "alert" : undefined} className="break-words text-fail">{task.message}</p>
      )}
      {complete.isError && <p role="alert" className="break-words text-fail">{errorMessage(complete.error)}</p>}
      {actionable && (
        <footer className="flex gap-1.5">
          <Button size="xs" variant="primary" className="flex-1" disabled={complete.isPending}
            onClick={() => complete.mutate("confirmed")}>
            <CheckIcon />{complete.isPending ? "正在提交…" : "完成"}
          </Button>
          <Button size="xs" variant="outline" className="flex-1" disabled={complete.isPending}
            onClick={() => complete.mutate("rejected")}>
            <XIcon />未完成
          </Button>
        </footer>
      )}
      <ImageViewer
        src={preview?.url}
        title={preview?.title ?? "端口图"}
        open={Boolean(preview)}
        onOpenChange={(open) => { if (!open) setPreview(undefined); }}
      />
    </section>
  );
}

/** One end of the cable: connector thumbnail (opens the viewer) beside its name. */
function Endpoint({ portRef, hardware, onPreview }: {
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
  return (
    <div className="flex min-w-0 items-center gap-2">
      {url.data ? (
        <button
          type="button"
          aria-label={`查看全图：${title}`}
          className={cn(
            "size-12 shrink-0 cursor-zoom-in overflow-hidden rounded-sm border border-line bg-surface-0 outline-none",
            "hover:border-signal focus-visible:outline-2 focus-visible:outline-signal"
          )}
          onClick={() => onPreview({ url: url.data!, title })}
        >
          <img className="size-full object-cover" src={url.data} alt={title} />
        </button>
      ) : (
        <span
          title={assetId ? url.isError ? "端口图加载失败" : "正在加载端口图…" : "暂无端口图"}
          className="grid size-12 shrink-0 place-items-center rounded-sm border border-dashed border-line text-fg-3"
        >
          <ImageOffIcon aria-hidden className="size-4" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-fg">{owner?.label ?? portRef}</span>
        <span className="block truncate font-mono text-2xs text-fg-3">{port?.name ?? "未知端口"}</span>
      </span>
    </div>
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
    <span className="tf-num text-2xs text-run">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
  );
}
