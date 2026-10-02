import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunMessages as RunMessagesData } from "@hardwareharness/contracts/observability";
import { cn, EmptyState, Select } from "../../ui";
import { relativeTime, type ConsoleJump } from "../streams/index.js";
import {
  decodedText, filterMessages, messageFilters, messageIndexAt, messageLabel, spacedHex
} from "./run-messages.js";

const ROW_PX = 26;
const OVERSCAN = 12;
const COLUMNS = "grid-cols-[84px_34px_128px_minmax(0,1fr)_minmax(0,1.2fr)]";

/**
 * Message table of a run (design §6.4): every frame on a protocol-bound stream with its raw bytes
 * next to what the frozen ICD decoded from them; undecodable frames and unframed bytes in the
 * failure tone. A click on a row picks its instant; `jump` scrolls to an instant picked elsewhere.
 */
export function RunMessages({ data, origin, jump, onPick }: {
  data: RunMessagesData;
  origin: number | undefined;
  jump?: ConsoleJump | undefined;
  onPick?: (tb: number) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  const [picked, setPicked] = useState<number>();
  const viewport = useRef<HTMLDivElement>(null);
  const filters = useMemo(() => messageFilters(data.bindings), [data.bindings]);
  const rows = useMemo(() => filterMessages(data.messages, filter), [data.messages, filter]);
  const zero = origin ?? data.messages[0]?.tb ?? 0;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 480));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!jump || !element || !rows.length) return;
    const index = messageIndexAt(rows, jump.tb);
    setPicked(index);
    element.scrollTop = Math.max(0, index * ROW_PX - element.clientHeight / 2);
  }, [jump, rows]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_PX) - OVERSCAN);
  const end = Math.min(rows.length, start + Math.ceil(height / ROW_PX) + OVERSCAN * 2);
  const missing = data.bindings.filter((binding) => !binding.recorded);
  return (
    <section aria-label="报文" className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-2xs text-fg-3">
        <Select aria-label="报文筛选" className="w-40" value={filter} onChange={(event) => setFilter(event.target.value)}>
          {filters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </Select>
        <span className="tf-num">
          {rows.length} 条{data.truncated ? `（共 ${data.total} 条，仅显示前 ${data.messages.length} 条）` : ""}
        </span>
        {missing.length > 0 && (
          <span className="truncate">未录制：{missing.map((binding) => binding.source).join("、")}</span>
        )}
        <span className="ml-auto truncate">
          {data.bindings.map((binding) => `${binding.alias} ← ${binding.icd}`).join("  ")}
        </span>
      </header>
      <div className={cn("grid shrink-0 gap-2 border-b border-line px-2 py-1 text-2xs text-fg-3", COLUMNS)}>
        <span>时间</span><span>方向</span><span>报文</span><span>原始</span><span>解码</span>
      </div>
      {rows.length ? (
        <div
          ref={viewport}
          className="min-h-0 flex-1 overflow-auto font-mono text-2xs"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div className="relative" style={{ height: rows.length * ROW_PX }}>
            {rows.slice(start, end).map((row, offset) => {
              const index = start + offset;
              const failed = row.kind !== "message";
              return (
                <button
                  key={`${row.streamId}:${row.seq ?? ""}:${row.tb ?? row.t}:${index}`}
                  type="button"
                  aria-pressed={picked === index}
                  className={cn(
                    "absolute right-0 left-0 grid items-center gap-2 overflow-hidden border-b border-line px-2",
                    "text-left",
                    "hover:bg-surface-2 aria-pressed:bg-surface-3",
                    COLUMNS
                  )}
                  style={{ top: index * ROW_PX, height: ROW_PX }}
                  onClick={() => {
                    setPicked(index);
                    if (row.tb != null) onPick?.(row.tb);
                  }}
                >
                  <span className="tf-num text-fg-3">{row.tb != null ? relativeTime(row.tb, zero) : "—"}</span>
                  <span className="text-fg-3">{(row.dir ?? "").toUpperCase()}</span>
                  <span className={cn("truncate", failed ? "text-fail" : "text-fg")}>{messageLabel(row)}</span>
                  <span className="truncate text-fg-2" title={spacedHex(row.raw)}>{spacedHex(row.raw)}</span>
                  <span className={cn("truncate", failed ? "text-fail" : "text-fg")} title={decodedText(row)}>
                    {decodedText(row)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div ref={viewport} className="min-h-0 flex-1">
          <EmptyState title="没有报文" description={filter === "all" ? "绑定的数据流上尚未解出报文。" : "没有符合筛选的报文。"} />
        </div>
      )}
    </section>
  );
}
