import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware } from "@teststand/contracts/devices";
import type { WiringTask, WiringTaskChange } from "@teststand/contracts/wiring";
import { ArrowRightIcon, CableIcon, CheckIcon, UnplugIcon, XIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { pinText, resolvePortRef } from "../../lib/hardware.js";
import { Badge, Button, cn } from "../../ui/index.js";
import { isTaskActionable, taskStatusLabel, taskTone } from "./wiring-model.js";

/** Work order for one wiring request: every cable to connect or disconnect, their pin maps and the
 *  operator's single answer. Shown in the agent conversation, which waits until it is answered. */
export function WiringTaskCard({ task, hardware, onChanged, className }: {
  task: WiringTask;
  hardware: Hardware[];
  onChanged?: () => Promise<void> | void;
  className?: string;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") => window.teststand.wiring.completeTask({
      taskId: task.wiringTaskId,
      outcome,
      ...(outcome === "rejected" && reason.trim() ? { message: reason.trim() } : {})
    }),
    onSettled: async () => { await onChanged?.(); }
  });
  const actionable = isTaskActionable(task);
  const tone = taskTone(task.status);
  const connects = task.changes.filter((change) => change.action === "connect").length;
  const disconnects = task.changes.length - connects;
  const summary = [connects && `连接 ${connects} 根`, disconnects && `断开 ${disconnects} 根`].filter(Boolean).join("，");
  return (
    <section
      aria-label="接线任务"
      className={cn(
        "relative grid gap-2 overflow-hidden rounded-md border bg-surface-0/40 p-2.5 text-xs",
        actionable ? "border-signal/45" : "border-line",
        className
      )}
    >
      {actionable && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      <header className="flex min-w-0 items-center gap-2">
        <CableIcon aria-hidden className="size-4 shrink-0 text-signal" />
        <h3 className="text-sm font-medium text-fg">请按清单接线</h3>
        <span className="text-2xs text-fg-3">{summary}</span>
        <Badge tone={tone} className="ml-auto">{taskStatusLabel(task.status)}</Badge>
      </header>
      {task.note && <p className="break-words text-fg-2">{task.note}</p>}
      <ol aria-label="接线清单" className="grid gap-1.5">
        {task.changes.map((change, index) => (
          <ChangeItem key={`${change.portA}|${change.portB}`} index={index} change={change} hardware={hardware} />
        ))}
      </ol>
      {task.message && (
        <p role={task.status === "failed" ? "alert" : undefined} className="break-words text-fail">{task.message}</p>
      )}
      {complete.isError && <p role="alert" className="break-words text-fail">{errorMessage(complete.error)}</p>}
      {actionable && rejecting && (
        <textarea
          aria-label="未完成原因"
          placeholder="告诉 AI 为什么没有接（可选）"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={cn(
            "resize-none rounded-sm border border-line bg-surface-0 px-2 py-1 text-xs text-fg outline-none",
            "focus:border-signal"
          )}
        />
      )}
      {actionable && (
        <footer className="flex gap-1.5">
          <Button size="xs" variant="primary" className="flex-1" disabled={complete.isPending}
            onClick={() => complete.mutate("confirmed")}>
            <CheckIcon />{complete.isPending ? "正在提交…" : "已全部完成"}
          </Button>
          <Button size="xs" variant="outline" className="flex-1" disabled={complete.isPending}
            onClick={() => rejecting ? complete.mutate("rejected") : setRejecting(true)}>
            <XIcon />{rejecting ? "提交未完成" : "未完成"}
          </Button>
        </footer>
      )}
    </section>
  );
}

/** One cable of the request: both connectors and its pin map. */
function ChangeItem({ index, change, hardware }: { index: number; change: WiringTaskChange; hardware: Hardware[] }) {
  const a = resolvePortRef(change.portA, hardware);
  const b = resolvePortRef(change.portB, hardware);
  const samePort = change.portA === change.portB;
  const disconnect = change.action === "disconnect";
  return (
    <li aria-label={disconnect ? "断开" : "连接"} className="grid gap-1 rounded-sm border border-line bg-surface-0 p-1.5">
      <div className={cn(
        "grid items-center gap-2",
        samePort ? "grid-cols-[16px_14px_minmax(0,1fr)]" : "grid-cols-[16px_14px_minmax(0,1fr)_14px_minmax(0,1fr)]"
      )}>
        <span className="tf-num text-right text-2xs text-fg-3">{index + 1}</span>
        {disconnect
          ? <UnplugIcon aria-hidden className="size-3.5 text-fail" />
          : <CableIcon aria-hidden className="size-3.5 text-signal" />}
        <Endpoint portRef={change.portA} hardware={hardware} />
        {!samePort && <>
          <ArrowRightIcon aria-hidden className="size-3.5 text-fg-3" />
          <Endpoint portRef={change.portB} hardware={hardware} />
        </>}
      </div>
      {change.pins.length > 0 && (
        <ol aria-label="针脚对应" className="ml-[38px] grid gap-px rounded-xs border border-line bg-line">
          {change.pins.map((pin) => (
            <li
              key={`${pin.a}-${pin.b}`}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_12px_minmax(0,1fr)] items-center gap-1.5",
                "bg-surface-0 px-2 py-0.5"
              )}
            >
              <span className="break-words text-fg">{pinText(a.port, pin.a)}</span>
              <ArrowRightIcon aria-hidden className="size-3 text-signal" />
              <span className="break-words text-fg">{pinText(b.port, pin.b)}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** One end of the cable: device label above its port name. */
function Endpoint({ portRef, hardware }: { portRef: string; hardware: Hardware[] }) {
  const { hardware: owner, port } = resolvePortRef(portRef, hardware);
  return (
    <span className="min-w-0">
      <span className="block truncate text-fg">{owner?.label ?? portRef}</span>
      <span className="block truncate font-mono text-2xs text-fg-3">{port?.name ?? "未知端口"}</span>
    </span>
  );
}
