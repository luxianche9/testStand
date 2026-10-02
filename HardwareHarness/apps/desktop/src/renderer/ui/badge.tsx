import * as React from "react";
import type { TestVerdict } from "@hardwareharness/contracts/testing";
import { cn, toneSurface, type Tone } from "./cn";
import { verdictLabels, verdictTone } from "./status";

export function Badge({ tone = "neutral", mono, className, ...props }: React.ComponentPropsWithoutRef<"span"> & {
  tone?: Tone;
  /** Mono style for codes, verdicts and counters. */
  mono?: boolean;
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm border px-1.5 text-2xs leading-none font-medium",
        "whitespace-nowrap",
        mono && "font-mono uppercase",
        toneSurface[tone],
        className
      )}
      {...props}
    />
  );
}

export function VerdictBadge({ verdict, className }: { verdict: TestVerdict | undefined; className?: string }) {
  if (!verdict || verdict === "NotSet") return <Badge className={className}>未运行</Badge>;
  return <Badge mono tone={verdictTone(verdict)} className={className}>{verdictLabels[verdict]}</Badge>;
}
