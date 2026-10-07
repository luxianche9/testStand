import { useMemo, useState, type ReactNode } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import type { WiringChange } from "@teststand/contracts/wiring";
import { BotIcon, UserIcon } from "lucide-react";
import { portLabel } from "../../lib/hardware.js";
import { useWiringChanges } from "../../lib/queries.js";
import { SegmentedControl } from "../../ui/index.js";
import { pinCountText } from "./wiring-model.js";

type Filter = "all" | "ai" | "manual";

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
});

function logTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? clockFormat.format(date) : dateFormat.format(date);
}

const changeVerbs: Record<WiringChange["kind"], string> = { added: "新增接线", removed: "删除接线", changed: "修改接线" };

/** 接线日志 of the bench: every change to the saved wiring, newest first. A change made by a confirmed
 *  AI wiring task is marked as such; wiring requests themselves are answered in the conversation. */
export function WiringLogPanel({ hardware, header, ...props }: {
  hardware: Hardware[];
  /** Replaces the default title strip. */
  header?: ReactNode;
  id?: string;
  role?: string;
}) {
  const changes = useWiringChanges();
  const [filter, setFilter] = useState<Filter>("all");
  const entries = useMemo(
    () => [...(changes.data ?? [])].sort((a, b) => b.at.localeCompare(a.at)),
    [changes.data]
  );
  const visible = entries.filter((entry) =>
    filter === "all" || (filter === "ai") === Boolean(entry.wiringTaskId));

  return (
    <section aria-label="接线日志" className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1" {...props}>
      {header ?? (
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <h2 className="tf-label text-fg-2">接线日志</h2>
          <span className="tf-num text-xs text-fg-3">{entries.length}</span>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LogGroup
          label="变更记录"
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
                { value: "ai", label: "AI 接线" },
                { value: "manual", label: "人工更改" }
              ]}
            />
          )}
        >
          {visible.map((entry) => <ChangeEntry key={entry.entryId} change={entry} hardware={hardware} />)}
          {visible.length === 0 && (
            <li className="px-3 py-4 text-xs leading-5 text-fg-3">
              {filter === "manual"
                ? "暂无人工更改。在针脚表中新增、修改或删除接线后会记录在这里。"
                : "暂无接线变更。在对话中确认 AI 的接线任务、或人工更改接线后会记录在这里。"}
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

/** One edit of a connection: what it became (or was, when removed), by the operator or a confirmed AI task. */
function ChangeEntry({ change, hardware }: { change: WiringChange; hardware: Hardware[] }) {
  const ends = `${portLabel(change.portA, hardware)} ↔ ${portLabel(change.portB, hardware)}`;
  const title = `${changeVerbs[change.kind]} ${ends}`;
  const moved = change.previous && (change.previous.portA !== change.portA || change.previous.portB !== change.portB);
  return (
    <li className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-line px-3 py-2" title={title}>
      {change.wiringTaskId
        ? <BotIcon aria-label="AI 接线" className="mt-0.5 size-3.5 text-signal" />
        : <UserIcon aria-label="人工更改" className="mt-0.5 size-3.5 text-fg-3" />}
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
