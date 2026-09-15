import { useMemo } from "react";
import type { WiringTask } from "@hardwareharness/contracts/wiring";

import { Badge, badgeVariantFromTone } from "../shared/ui/badge";
import { pinCountText, taskStatusLabel, taskTitle, taskTone } from "../features/wiring/wiring-model.js";

export function MailboxDropdown({ tasks, hardware, onClose, onOpenTask }: {
  tasks: WiringTask[];

  hardware: Parameters<typeof taskTitle>[1];
  onClose: () => void;
  onOpenTask: (task: WiringTask) => void;
}) {
  const items = useMemo(() => [...tasks].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt)), [tasks]);

  return (
    <div className="fixed inset-0 z-[60]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-label="信箱" className="absolute top-12 right-3 grid max-h-[60vh] w-[420px] max-w-[calc(100vw-24px)] animate-fade-in grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg bg-popover shadow-[var(--tf-shadow-lg)] ring-1 ring-border">
        <header className="flex items-center justify-between bg-card px-4 py-2.5 text-[13px] font-semibold tracking-tight">
          信箱<span className="text-xs font-normal text-muted-foreground">{items.length} 条</span>
        </header>
        <div className="grid content-start gap-0.5 overflow-y-auto p-1.5">
          {items.map((task) => (
            <button type="button" key={task.wiringTaskId} onClick={() => onOpenTask(task)} className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Badge variant={badgeVariantFromTone(taskTone(task.status))}>{taskStatusLabel(task.status)}</Badge>
              <span className="grid min-w-0">
                <strong className="truncate text-sm font-medium">{taskTitle(task, hardware)}</strong>
                <small className="truncate text-xs text-muted-foreground">{task.message || (task.warnings.length ? task.warnings.join("；") : pinCountText(task))}</small>
                <time className="mt-1 text-[11px] text-muted-foreground">{new Date(task.requestedAt).toLocaleString()}</time>
              </span>
            </button>
          ))}
          {!items.length && <div className="py-6 text-center text-sm text-muted-foreground">信箱中暂无请求。</div>}
        </div>
      </section>
    </div>
  );
}
