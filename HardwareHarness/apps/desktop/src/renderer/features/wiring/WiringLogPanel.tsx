import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { WiringChange, WiringTask } from "@hardwareharness/contracts/wiring";
import { BotIcon, ChevronRightIcon, UserIcon } from "lucide-react";
import { portLabel } from "../../lib/hardware.js";
import { invalidateWiringData } from "../../lib/mutations.js";
import { useWiringChanges, useWiringTasks } from "../../lib/queries.js";
import { SegmentedControl, StatusLamp, cn, toneText } from "../../ui/index.js";
import { WiringTaskCard } from "./WiringTaskCard.js";
import { isTaskActionable, pinCountText, taskStatusLabel, taskTitle, taskTone } from "./wiring-model.js";

type Filter = "all" | "ai" | "manual";
type LogEntry =
  | { kind: "task"; id: string; at: string; task: WiringTask }
  | { kind: "change"; id: string; at: string; change: WiringChange };

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
});

function logTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? clockFormat.format(date) : dateFormat.format(date);
}

const changeVerbs: Record<WiringChange["kind"], string> = { added: "新增接线", removed: "删除接线", changed: "修改接线" };

/** 接线日志 of the bench: AI wiring guidance and the operator's own canvas edits, newest first.
 *  Open requests sit on top as live cards; both sources are persisted in the project's runtime store. */
export function WiringLogPanel({ hardware, header, ...props }: {
  hardware: Hardware[];
  /** Replaces the default title strip. */
  header?: ReactNode;
  id?: string;
  role?: string;
}) {
  const client = useQueryClient();
  const tasks = useWiringTasks();
  const changes = useWiringChanges();
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string>();
  const refresh = async () => { await invalidateWiringData(client); };
  const pending = useMemo(
    () => (tasks.data ?? []).filter(isTaskActionable).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [tasks.data]
  );
  const entries = useMemo(() => {
    const history: LogEntry[] = [
      ...(tasks.data ?? []).filter((task) => !isTaskActionable(task)).map((task) => ({
        kind: "task" as const, id: task.wiringTaskId, at: task.completedAt ?? task.requestedAt, task
      })),
      ...(changes.data ?? []).map((change) => ({ kind: "change" as const, id: change.entryId, at: change.at, change }))
    ];
    return history.sort((a, b) => b.at.localeCompare(a.at));
  }, [tasks.data, changes.data]);
  const visible = entries.filter((entry) =>
    filter === "all" || (filter === "ai" ? entry.kind === "task" : entry.kind === "change"));

  return (
    <section aria-label="接线日志" className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1" {...props}>
      {header ?? (
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <h2 className="tf-label text-fg-2">接线日志</h2>
          <span className="tf-num text-xs text-fg-3">{entries.length}</span>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pending.length > 0 && (
          <LogGroup label="待处理" count={pending.length}>
            {pending.map((task) => (
              <li key={task.wiringTaskId} className="border-b border-line p-2">
                <WiringTaskCard task={task} hardware={hardware} onChanged={refresh} />
              </li>
            ))}
          </LogGroup>
        )}
        <LogGroup
          label="历史记录"
          count={visible.length}
          actions={(
            <SegmentedControl<Filter>
              label="日志来源"
              size="xs"
              className="ml-auto"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "全部" },
                { value: "ai", label: "AI 指导" },
                { value: "manual", label: "人工更改" }
              ]}
            />
          )}
        >
          {visible.map((entry) => entry.kind === "task" ? (
            <TaskEntry
              key={entry.id}
              task={entry.task}
              hardware={hardware}
              open={openId === entry.id}
              onToggle={() => setOpenId((current) => current === entry.id ? undefined : entry.id)}
            />
          ) : <ChangeEntry key={entry.id} change={entry.change} hardware={hardware} />)}
          {visible.length === 0 && (
            <li className="px-3 py-4 text-xs leading-5 text-fg-3">
              {filter === "manual"
                ? "暂无人工更改。在画布上新增、修改或删除接线后会记录在这里。"
                : "暂无接线记录。AI 通过 MCP 请求接线或断线、以及画布上的人工更改都会记录在这里。"}
            </li>
          )}
        </LogGroup>
      </div>
    </section>
  );
}

function LogGroup({ label, count, actions, children }: {
  label: string; count: number; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <section aria-label={label}>
      <h3 className="sticky top-0 z-[1] flex h-8 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span className="tf-label text-fg-3">{label}</span>
        <span className="tf-num text-2xs text-fg-3">{count}</span>
        {actions}
      </h3>
      <ul className="grid grid-cols-[minmax(0,1fr)]">{children}</ul>
    </section>
  );
}

/** A finished AI request; expands in place to its read-only work order. */
function TaskEntry({ task, hardware, open, onToggle }: {
  task: WiringTask; hardware: Hardware[]; open: boolean; onToggle: () => void;
}) {
  const tone = taskTone(task.status);
  const title = taskTitle(task, hardware);
  return (
    <li className="border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title={title}
        className={cn(
          "grid w-full grid-cols-[14px_minmax(0,1fr)] gap-x-2 gap-y-0.5 px-3 py-2 text-left outline-none",
          "hover:bg-surface-2 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal"
        )}
      >
        <BotIcon aria-label="AI 指导" className="mt-0.5 size-3.5 text-signal" />
        <span className="flex min-w-0 items-start gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-5 text-fg">{title}</span>
          <span className={cn("shrink-0 text-2xs leading-5", toneText[tone])}>{taskStatusLabel(task.status)}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn("mt-1 size-3 shrink-0 text-fg-3 transition-transform", open && "rotate-90")}
          />
        </span>
        <EntryMeta at={task.completedAt ?? task.requestedAt}>
          <StatusLamp tone={tone} />
          <span className="min-w-0 truncate">{pinCountText(task)}</span>
        </EntryMeta>
      </button>
      {open && <WiringTaskCard task={task} hardware={hardware} className="mx-2 mb-2" />}
    </li>
  );
}

/** One operator edit on the canvas: what the connection became (or was, when removed). */
function ChangeEntry({ change, hardware }: { change: WiringChange; hardware: Hardware[] }) {
  const ends = `${portLabel(change.portA, hardware)} ↔ ${portLabel(change.portB, hardware)}`;
  const title = `${changeVerbs[change.kind]} ${ends}`;
  const moved = change.previous && (change.previous.portA !== change.portA || change.previous.portB !== change.portB);
  return (
    <li className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-line px-3 py-2" title={title}>
      <UserIcon aria-label="人工更改" className="mt-0.5 size-3.5 text-fg-3" />
      <span className="line-clamp-2 min-w-0 text-sm leading-5 text-fg">{title}</span>
      <EntryMeta at={change.at}>
        <span className="min-w-0 truncate">
          {change.previous && !moved
            ? `针脚 ${change.previous.pins.length} → ${change.pins.length} 对`
            : moved && change.previous
              ? `原 ${portLabel(change.previous.portA, hardware)} ↔ ${portLabel(change.previous.portB, hardware)}`
              : pinCountText(change)}
        </span>
      </EntryMeta>
    </li>
  );
}

function EntryMeta({ at, children }: { at: string; children: ReactNode }) {
  return (
    <span className="col-start-2 flex min-w-0 items-center gap-2 text-2xs text-fg-3">
      {children}
      <time className="tf-num ml-auto shrink-0" dateTime={at}>{logTime(at)}</time>
    </span>
  );
}
