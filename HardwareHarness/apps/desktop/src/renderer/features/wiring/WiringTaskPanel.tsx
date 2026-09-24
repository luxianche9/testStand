import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { CheckIcon, XIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { invalidateWiringData } from "../../lib/mutations.js";
import { useWiringTasks } from "../../lib/queries.js";
import { Button, StatusLamp, cn, toneText } from "../../ui/index.js";
import { WiringTaskModal } from "./WiringTaskModal.js";
import { isTaskActionable, pinCountText, taskStatusLabel, taskTitle, taskTone } from "./wiring-model.js";

export { WiringTaskModal } from "./WiringTaskModal.js";

type TaskOutcome = { id: string; outcome: "confirmed" | "rejected" };

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
});

function taskTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? clockFormat.format(date) : dateFormat.format(date);
}

/** Right sidebar of the wiring bench: open requests raised through MCP on top, then every past task. */
export function WiringTaskPanel({ hardware }: { hardware: Hardware[] }) {
  const client = useQueryClient();
  const tasks = useWiringTasks();
  const [openId, setOpenId] = useState<string>();
  const refresh = async () => { await invalidateWiringData(client); };
  const complete = useMutation({
    mutationFn: ({ id, outcome }: TaskOutcome) => window.hardwareharness.wiring.completeTask(id, outcome),
    onSettled: refresh
  });
  const sorted = useMemo(
    () => [...(tasks.data ?? [])].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [tasks.data]
  );
  const pending = sorted.filter(isTaskActionable);
  const history = sorted.filter((task) => !isTaskActionable(task));
  const open = sorted.find((task) => task.wiringTaskId === openId);
  const row = (task: WiringTask) => (
    <TaskRow
      key={task.wiringTaskId}
      task={task}
      hardware={hardware}
      busy={complete.isPending}
      onOpen={() => setOpenId(task.wiringTaskId)}
      onComplete={(outcome) => complete.mutate({ id: task.wiringTaskId, outcome })}
    />
  );

  return (
    <section aria-label="接线任务列表" className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="tf-label text-fg-2">接线任务</h2>
        <span className="tf-num text-xs text-fg-3">{sorted.length}</span>
      </header>
      {complete.isError && (
        <p role="alert" className="border-b border-line px-3 py-1.5 text-xs break-words text-fail">
          {errorMessage(complete.error)}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sorted.length ? <>
          {pending.length > 0 && <TaskGroup label="待处理" count={pending.length}>{pending.map(row)}</TaskGroup>}
          {history.length > 0 && <TaskGroup label="历史任务" count={history.length}>{history.map(row)}</TaskGroup>}
        </> : (
          <p className="px-3 py-4 text-xs leading-5 text-fg-3">
            暂无接线任务。AI 通过 MCP 请求接线或断线时会出现在这里。
          </p>
        )}
      </div>
      {open && (
        <WiringTaskModal
          key={open.wiringTaskId}
          task={open}
          hardware={hardware}
          onChanged={refresh}
          onClose={() => setOpenId(undefined)}
        />
      )}
    </section>
  );
}

function TaskGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h3 className="sticky top-0 z-[1] flex h-7 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span className="tf-label text-fg-3">{label}</span>
        <span className="tf-num text-2xs text-fg-3">{count}</span>
      </h3>
      <ul className="grid grid-cols-[minmax(0,1fr)]">{children}</ul>
    </section>
  );
}

function TaskRow({ task, hardware, busy, onOpen, onComplete }: {
  task: WiringTask; hardware: Hardware[]; busy: boolean;
  onOpen: () => void; onComplete: (outcome: TaskOutcome["outcome"]) => void;
}) {
  const tone = taskTone(task.status);
  const title = taskTitle(task, hardware);
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={onOpen}
        title={title}
        className={cn(
          "grid w-full gap-0.5 px-3 py-2 text-left outline-none hover:bg-surface-2",
          "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal"
        )}
      >
        <span className="flex min-w-0 items-start gap-2">
          <StatusLamp tone={tone} pulse={task.status === "in_progress"} className="mt-1.5" />
          <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-5 text-fg">{title}</span>
          {/* The 待处理 group already says so; only other states need a word. */}
          {task.status !== "pending" && (
            <span className={cn("shrink-0 text-2xs leading-5", toneText[tone])}>{taskStatusLabel(task.status)}</span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 pl-3.5 text-2xs text-fg-3">
          <span className="min-w-0 truncate">{pinCountText(task)}</span>
          <time className="tf-num ml-auto shrink-0" dateTime={task.requestedAt}>{taskTime(task.requestedAt)}</time>
        </span>
      </button>
      {isTaskActionable(task) && (
        <span className="flex gap-1.5 px-3 pb-2 pl-6.5">
          <Button size="xs" variant="primary" className="flex-1" disabled={busy}
            onClick={() => onComplete("confirmed")}>
            <CheckIcon />完成
          </Button>
          <Button size="xs" variant="outline" className="flex-1" disabled={busy}
            onClick={() => onComplete("rejected")}>
            <XIcon />未完成
          </Button>
        </span>
      )}
    </li>
  );
}
