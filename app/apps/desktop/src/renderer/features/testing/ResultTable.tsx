import { useMemo, useState } from "react";
import { cn, StatusLamp, toneText, verdictTone } from "../../ui";
import type { ResultRow } from "./result-rows.js";

const LABEL: Record<ResultRow["verdict"], string> = {
  Pass: "通过", Fail: "不通过", Inconclusive: "不确定", Error: "错误"
};

/**
 * The run's results as a table — 测点 · 测量值 · 限值 · 位置 · 说明 — the first thing a test
 * engineer reads; the oscilloscope and the console explain a row. A row's bar shows where the
 * value lies between its limits (a window's whole range when it judged a window). A click on a
 * row zooms the time axis, the oscilloscope and the console to its step.
 */
export function ResultTable({ rows, onStep }: {
  rows: readonly ResultRow[];
  onStep: (executionId: string) => void;
}) {
  const problems = rows.filter((row) => row.verdict !== "Pass").length;
  const [onlyProblems, setOnlyProblems] = useState(false);
  const shown = useMemo(
    () => onlyProblems ? rows.filter((row) => row.verdict !== "Pass") : rows,
    [rows, onlyProblems]
  );
  if (!rows.length) {
    return <p className="grid h-full place-items-center text-2xs text-fg-3">这次运行还没有判定结果</p>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-line px-2 text-2xs text-fg-3">
        <span className="tf-num">{rows.length} 项</span>
        {problems > 0 ? (
          <button
            type="button"
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems((value) => !value)}
            className={cn(
              "tf-num h-5 rounded-sm border px-1.5",
              onlyProblems ? "border-line-strong bg-surface-2 text-fg" : "border-dashed border-line"
            )}
          >
            只看问题 {problems}
          </button>
        ) : <span className="text-pass">全部通过</span>}
      </div>
      <div role="table" aria-label="判定结果" className="min-h-0 flex-1 overflow-auto">
        <div
          role="row"
          className={cn(GRID, "sticky top-0 z-10 h-6 border-b border-line bg-surface-1",
            "text-2xs font-semibold text-fg-3")}
        >
          {["结论", "测点", "测量值", "限值", "位置", "说明"].map((label) => (
            <span key={label} role="columnheader" className="truncate">{label}</span>
          ))}
        </div>
        {shown.map((row) => {
          const tone = verdictTone(row.verdict);
          const clickable = Boolean(row.executionId);
          return (
            <div
              key={row.id}
              role="row"
              tabIndex={clickable ? 0 : undefined}
              title={clickable ? "定位到这一步" : undefined}
              onClick={() => row.executionId && onStep(row.executionId)}
              onKeyDown={(event) => { if (event.key === "Enter" && row.executionId) onStep(row.executionId); }}
              className={cn(
                GRID, "h-7 border-b border-line/60 text-xs",
                clickable && "cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none",
                row.verdict !== "Pass" && "bg-fail/4"
              )}
            >
              <span role="cell" className={cn("flex items-center gap-1.5 font-medium", toneText[tone])}>
                <StatusLamp tone={tone} />{LABEL[row.verdict]}
              </span>
              <span role="cell" className="truncate text-fg" title={row.name}>{row.name}</span>
              <span role="cell" className={cn("tf-num truncate text-right font-mono",
                row.verdict === "Fail" ? "text-fail" : "text-fg")}>
                {row.valueText || "—"}
              </span>
              <span role="cell" className="tf-num truncate font-mono text-fg-2">{row.limitText || "—"}</span>
              <span role="cell"><LimitBar row={row} /></span>
              <span role="cell" className="truncate text-fg-3" title={row.reason}>{row.reason ?? ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const GRID = "grid grid-cols-[64px_minmax(120px,1.4fr)_minmax(88px,0.8fr)_minmax(88px,0.8fr)_96px_minmax(80px,1.2fr)]"
  + " items-center gap-2 px-2";

/**
 * Where the value lies between the lower and upper limit: the band between them, the value (or
 * a window's range) as a tick, red outside. Nothing when the step has no two-sided limit.
 */
function LimitBar({ row }: { row: Pick<ResultRow, "lower" | "upper" | "span" | "verdict"> }) {
  const { lower, upper, span } = row;
  if (lower === undefined || upper === undefined || !span || upper <= lower) return null;
  const width = upper - lower;
  // A tenth of the band either side shows a value just outside the limits.
  const min = lower - width * 0.1;
  const max = upper + width * 0.1;
  const at = (value: number) => `${((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100}%`;
  const outside = span[0] < lower || span[1] > upper;
  return (
    <div className="relative h-2.5 w-full" aria-label={outside ? "超出限值" : "在限值内"}>
      <div className="absolute inset-y-0.5 rounded-xs bg-surface-3"
        style={{ left: at(lower), width: `calc(${at(upper)} - ${at(lower)})` }} />
      <div
        className={cn("absolute inset-y-0 min-w-0.5 rounded-xs", outside ? "bg-fail" : "bg-pass")}
        style={{ left: at(span[0]), width: `max(2px, calc(${at(span[1])} - ${at(span[0])}))` }}
      />
    </div>
  );
}
