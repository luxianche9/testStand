import { useState } from "react";
import type { TestRunEvent } from "@teststand/contracts/testing";
import { Select } from "../../ui";
import { eventDetail, filterEvents, formatTime } from "./run-format.js";

/** Collapsible raw event log with a type filter; rows are virtualised. */
export function EventLog({ events }: { events: TestRunEvent[] }) {
  const [filter, setFilter] = useState("all");
  return (
    <details className="rounded-md border border-line bg-surface-1">
      <summary
        className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-fg"
      >
        技术事件
        <span className="tf-num text-2xs font-normal text-fg-3">{events.length} 条原始事件</span>
      </summary>
      <div className="border-t border-line">
        <div className="flex justify-end p-2">
          <Select
            aria-label="事件筛选"
            className="w-32"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">全部事件</option>
            <option value="step">步骤</option>
            <option value="operation">物理操作</option>
            <option value="error">错误</option>
          </Select>
        </div>
        <VirtualEventList events={filterEvents(events, filter)} />
      </div>
    </details>
  );
}

const rowHeight = 28;
const viewportHeight = 288;

function VirtualEventList({ events }: { events: TestRunEvent[] }) {
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
  const end = Math.min(events.length, start + Math.ceil(viewportHeight / rowHeight) + 16);
  return (
    <div
      className="overflow-auto font-mono text-2xs"
      style={{ height: viewportHeight }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: events.length * rowHeight }}>
        {events.slice(start, end).map((event, index) => (
          <div
            key={event.sequence}
            className={
              "absolute right-0 left-0 grid h-7 grid-cols-[44px_70px_150px_1fr] items-center gap-2 overflow-hidden "
              + "border-b border-line bg-surface-1 px-2"
            }
            style={{ top: (start + index) * rowHeight }}
          >
            <span className="tf-num text-fg-3">{event.sequence}</span>
            <span className="tf-num text-fg-3">{formatTime(event.at)}</span>
            <span className="text-fg">{event.type}</span>
            <span className="truncate text-fg-3">{eventDetail(event)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
