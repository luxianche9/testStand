import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware } from "@testforge/contracts/devices";
import type { WiringTask } from "@testforge/contracts/wiring";
import { errorMessage } from "../../shared/errors.js";
import { TriangleAlertIcon } from "lucide-react";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../shared/ui/dialog";
import { pinText, resolvePortRef } from "../../shared/hardware.js";
import { assetKey, taskTitle } from "./wiring-model.js";

export function WiringTaskModal({ task, hardware, assetUrls, onAssetUrl, onChanged }: {
  task: WiringTask; hardware: Hardware[];
  assetUrls: Record<string, string>; onAssetUrl: (key: string, url: string) => void; onChanged: () => Promise<void>;
}) {
  const start = useMutation({
    mutationFn: () => window.testforge.wiring.startTask(task.wiringTaskId, "operator"),
    onSuccess: async () => { await onChanged(); }
  });
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") => window.testforge.wiring.completeTask(task.wiringTaskId, outcome),
    onSuccess: async () => { await onChanged(); }
  });
  const a = resolvePortRef(task.portA, hardware);
  const b = resolvePortRef(task.portB, hardware);
  const pending = task.status === "pending";
  const busy = start.isPending || complete.isPending;
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent size="xl">
        <DialogHeader title={pending
          ? task.action === "connect" ? "待处理人工接线任务" : "待处理人工断线任务"
          : task.action === "connect" ? "人工接线任务" : "人工断线任务"} />
        <DialogBody>
          <div className="mb-3.5 flex items-center gap-2.5">
            <Badge variant="warning">{pending ? "等待开始" : "硬件已独占"}</Badge>
            <strong className="min-w-0 flex-1">{taskTitle(task, hardware)}</strong>
            <Countdown expiresAt={task.expiresAt} />
          </div>
          {task.warnings.length > 0 && <TaskAlert>{task.warnings.join("；")}</TaskAlert>}
          <div className="grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] items-center gap-2.5">
            <PortGuide portRef={task.portA} hardware={hardware} assetUrls={assetUrls} onAssetUrl={onAssetUrl} />
            <div className="text-center text-[22px] text-ring">→</div>
            <PortGuide portRef={task.portB} hardware={hardware} assetUrls={assetUrls} onAssetUrl={onAssetUrl} />
          </div>
          {task.pins.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
              <header className="flex items-center gap-2 bg-secondary/60 px-2.5 py-2 text-xs text-muted-foreground"><span>需要连接的针脚</span><strong>{task.pins.length}</strong></header>
              {task.pins.map((pin) => (
                <div key={`${pin.a}-${pin.b}`} className="grid grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)] gap-2 px-2.5 py-1.5 text-xs odd:bg-secondary/20">
                  <span>{pinText(a.port, pin.a)}</span>
                  <i className="grid place-items-center not-italic text-ring">→</i>
                  <span>{pinText(b.port, pin.b)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs leading-normal text-muted-foreground">
            {task.pins.length > 0
              ? "请按照端口图片上的针脚编号，逐条完成上表中的物理接线。确认「已完成」后，工程接线文档才会更新。"
              : "两端都没有登记针脚，按整个端口完成物理连接即可。确认「已完成」后，工程接线文档才会更新。"}
          </p>
          {(start.isError || complete.isError) && <TaskAlert>{errorMessage(start.error ?? complete.error)}</TaskAlert>}
        </DialogBody>
        <DialogFooter>
          {pending
            ? <Button onClick={() => start.mutate()} disabled={busy}>开始处理</Button>
            : <>
              <Button variant="outline" onClick={() => complete.mutate("rejected")} disabled={busy}>无法完成</Button>
              <Button onClick={() => complete.mutate("confirmed")} disabled={busy}>已完成</Button>
            </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 任务执行/校验失败时的提示条。 */
function TaskAlert({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none">
      <TriangleAlertIcon className="size-4" />
      <span>{children}</span>
    </div>
  );
}

function PortGuide({ portRef, hardware, assetUrls, onAssetUrl }: {
  portRef: string; hardware: Hardware[];
  assetUrls: Record<string, string>; onAssetUrl: (key: string, url: string) => void;
}) {
  const { hardware: owner, port } = resolvePortRef(portRef, hardware);
  const assetId = port?.imageAssetId;
  const key = owner && assetId ? assetKey(owner.hardwareId, assetId) : undefined;
  useEffect(() => {
    if (!owner || !assetId || !key || assetUrls[key] !== undefined) return;
    void window.testforge.devices.hardwareImageUrl(owner.hardwareId, assetId).then((url) => onAssetUrl(key, url));
  }, [assetId, assetUrls, key, onAssetUrl, owner]);
  const url = key ? assetUrls[key] : undefined;
  return (
    <article className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
      <header className="grid gap-0.5 bg-card px-2.5 py-2">
        <strong>{owner?.label ?? "未解析设备"}</strong>
        <span className="font-semibold text-ring">{port?.name ?? "未知端口"}{port ? `，${port.pins.length ? `${port.pins.length} 针` : "无针脚"}` : ""}</span>
      </header>
      <div className="grid h-[260px] place-items-center overflow-hidden bg-secondary/50 text-muted-foreground">
        {url ? <img className="size-full object-contain" src={url} alt={`${owner?.label ?? "硬件"} ${port?.name ?? "端口"}`} /> : <span className="text-xs">未上传端口图，请按针脚编号操作</span>}
      </div>
      <code className="block truncate px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">{portRef}</code>
    </article>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return <code>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</code>;
}

/* --------------------------------- 辅助 --------------------------------- */
