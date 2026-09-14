import { useMemo } from "react";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import type { HardwareOccupancyRequest } from "@hardwareharness/contracts/occupancy";
import { Badge, badgeVariantFromTone } from "../shared/ui/badge";
import { Button } from "../shared/ui/button";
import { pinCountText, taskTitle, taskTone } from "../features/wiring/wiring-model.js";

function occupancyTone(status: HardwareOccupancyRequest["status"]): ReturnType<typeof taskTone> {
  if (status === "confirmed") return "ok";
  if (status === "pending") return "warn";
  if (status === "rejected" || status === "failed" || status === "timed_out") return "bad";
  return "muted";
}

function occupancyHardwareLabel(request: HardwareOccupancyRequest, hardware: Parameters<typeof taskTitle>[1]): string {
  return request.hardwareIds.map((hardwareId) => hardware.find((item) => item.hardwareId === hardwareId)?.label ?? hardwareId).join("、");
}

export { occupancyHardwareLabel, occupancyTone };

export function MailboxDropdown({ tasks, occupancyRequests, hardware, busyRequestId, onOccupancyAction, onClose }: {
  tasks: WiringTask[];
  occupancyRequests: HardwareOccupancyRequest[];
  hardware: Parameters<typeof taskTitle>[1];
  busyRequestId: string | undefined;
  onOccupancyAction: (id: string, action: "acquire" | "reject") => void;
  onClose: () => void;
}) {
  const items = useMemo(() => [
    ...tasks.map((task) => ({ kind: "wiring" as const, requestedAt: task.requestedAt, task })),
    ...occupancyRequests.map((request) => ({ kind: "occupancy" as const, requestedAt: request.requestedAt, request }))
  ].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt)), [tasks, occupancyRequests]);

  return (
    <div className="fixed inset-0 z-[60]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-label="信箱" className="absolute top-12 right-3 grid max-h-[60vh] w-[420px] max-w-[calc(100vw-24px)] animate-fade-in grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg bg-popover shadow-[var(--tf-shadow-lg)] ring-1 ring-border">
        <header className="flex items-center justify-between bg-card px-4 py-2.5 text-[13px] font-semibold tracking-tight">
          信箱<span className="text-xs font-normal text-muted-foreground">{items.length} 条</span>
        </header>
        <div className="grid content-start gap-0.5 overflow-y-auto p-1.5">
          {items.map((item) => item.kind === "wiring" ? (
            <div key={item.task.wiringTaskId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent">
              <Badge variant={badgeVariantFromTone(taskTone(item.task.status))}>{item.task.status}</Badge>
              <span className="grid min-w-0">
                <strong className="truncate text-sm font-medium">接线 · {taskTitle(item.task, hardware)}</strong>
                <small className="truncate text-xs text-muted-foreground">{item.task.message || (item.task.warnings.length ? item.task.warnings.join("；") : pinCountText(item.task))}</small>
              </span>
              <time className="text-[11px] whitespace-nowrap text-muted-foreground">{new Date(item.task.requestedAt).toLocaleString()}</time>
            </div>
          ) : (
            <div key={item.request.occupancyRequestId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent">
              <Badge variant={badgeVariantFromTone(occupancyTone(item.request.status))}>{item.request.status}</Badge>
              <span className="grid min-w-0">
                <strong className="truncate text-sm font-medium">硬件占用 · {occupancyHardwareLabel(item.request, hardware)}</strong>
                <small className="truncate text-xs text-muted-foreground">{item.request.message || item.request.reason || "AI 请求人工占用硬件"}</small>
                {item.request.status === "pending" && (
                  <span className="mt-1.5 flex gap-1.5">
                    <Button size="xs" disabled={busyRequestId === item.request.occupancyRequestId} onClick={() => onOccupancyAction(item.request.occupancyRequestId, "acquire")}>占用全部</Button>
                    <Button size="xs" variant="outline" disabled={busyRequestId === item.request.occupancyRequestId} onClick={() => onOccupancyAction(item.request.occupancyRequestId, "reject")}>拒绝</Button>
                  </span>
                )}
              </span>
              <time className="text-[11px] whitespace-nowrap text-muted-foreground">{new Date(item.request.requestedAt).toLocaleString()}</time>
            </div>
          ))}
          {!items.length && <div className="py-6 text-center text-sm text-muted-foreground">信箱中暂无请求。</div>}
        </div>
      </section>
    </div>
  );
}
