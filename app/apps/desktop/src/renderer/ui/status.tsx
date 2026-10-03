import * as React from "react";
import type { TestVerdict } from "@teststand/contracts/testing";
import { cn, toneText, type Tone } from "./cn";

/** Small indicator light. `pulse` animates it for live/running states. */
export function StatusLamp({ tone = "neutral", pulse, className, label }: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
  /** Accessible label; lamps without one are decorative. */
  label?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-tone={tone}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full bg-current",
        tone === "neutral" ? "text-idle" : toneText[tone],
        tone !== "neutral" && "shadow-[0_0_0_2px_color-mix(in_oklch,currentColor_18%,transparent)]",
        pulse && "animate-lamp",
        className
      )}
    />
  );
}

/** Instrument readout: small uppercase label over a tabular mono value. */
export function Reading({ label, value, unit, tone, className }: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 gap-0.5", className)}>
      <span className="tf-label truncate">{label}</span>
      <span className={cn("tf-num truncate text-base leading-5 text-fg", tone && toneText[tone])}>
        {value}
        {unit && <span className="ml-1 text-xs text-fg-3">{unit}</span>}
      </span>
    </div>
  );
}

export function verdictTone(verdict: TestVerdict | undefined): Tone {
  switch (verdict) {
    case "Pass": return "pass";
    case "Fail":
    case "Error": return "fail";
    case "Inconclusive":
    case "Aborted": return "invalid";
    default: return "neutral";
  }
}

export const verdictLabels: Record<TestVerdict, string> = {
  NotSet: "未判定",
  Pass: "PASS",
  Inconclusive: "不确定",
  Fail: "FAIL",
  Aborted: "中止",
  Error: "错误"
};

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`;
}
