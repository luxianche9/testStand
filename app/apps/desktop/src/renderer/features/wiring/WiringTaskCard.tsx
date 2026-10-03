import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware } from "@teststand/contracts/devices";
import type { WiringTask } from "@teststand/contracts/wiring";
import { ArrowRightIcon, CableIcon, CheckIcon, UnplugIcon, XIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { pinText, resolvePortRef } from "../../lib/hardware.js";
import { Badge, Button, cn } from "../../ui/index.js";
import { isTaskActionable, taskStatusLabel, taskTone } from "./wiring-model.js";

/** Compact work order for one wiring request: both connectors, the pin map and the operator's answer.
 *  Embedded in the agent conversation (and the wiring log). */
export function WiringTaskCard({ task, hardware, onChanged, className }: {
  task: WiringTask;
  hardware: Hardware[];
  onChanged?: () => Promise<void> | void;
  className?: string;
}) {
  const complete = useMutation({
    mutationFn: (outcome: "confirmed" | "rejected") =>
      window.teststand.wiring.completeTask({ taskId: task.wiringTaskId, outcome }),
    onSettled: async () => { await onChanged?.(); }
  });
  const a = resolvePortRef(task.portA, hardware);
  const b = resolvePortRef(task.portB, hardware);
  const actionable = isTaskActionable(task);
  const samePort = task.portA === task.portB;
  const disconnect = task.action === "disconnect";
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
        <Endpoint portRef={task.portA} hardware={hardware} />
        {!samePort && <>
          <ArrowRightIcon aria-hidden className="size-3.5 text-fg-3" />
          <Endpoint portRef={task.portB} hardware={hardware} />
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
    </section>
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
