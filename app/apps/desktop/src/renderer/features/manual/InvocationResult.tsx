import type { ManualToolInvocationResult } from "@teststand/contracts/execution";
import { CircleAlertIcon } from "lucide-react";
import { formatDuration, Reading, StatusLamp, toneText, cn } from "../../ui";
import { invocationReadings } from "./invocation-readings.js";

export type InvocationOutcome =
  | { kind: "success"; result: ManualToolInvocationResult }
  | { kind: "failure"; message: string; durationMs: number };

/**
 * Result readout of one manual call. It is a `<section>` holding the verdict text and the single
 * `<pre>` with the raw JSON so the verdict and its payload stay one landmark.
 */
export function InvocationResult({ outcome }: { outcome: InvocationOutcome }) {
  const ok = outcome.kind === "success";
  const tone = ok ? "pass" : "fail";
  const durationMs = ok ? outcome.result.durationMs : outcome.durationMs;
  const readings = ok ? invocationReadings(outcome.result.output) : [];
  return (
    <section
      aria-live="polite"
      className={cn("overflow-hidden rounded-md border bg-surface-0", ok ? "border-pass/35" : "border-fail/40")}
    >
      <header className="flex h-7 items-center gap-2 border-b border-line px-2.5">
        <StatusLamp tone={tone} />
        <strong className={cn("text-xs font-semibold", toneText[tone])}>{ok ? "调用成功" : "调用失败"}</strong>
        <span className="tf-num ml-auto text-2xs text-fg-3">{formatDuration(durationMs)}</span>
      </header>
      {readings.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3 border-b border-line px-3 py-2.5">
          {readings.map((reading) => (
            <Reading
              key={reading.key}
              label={reading.key}
              value={reading.value}
              {...(reading.tone ? { tone: reading.tone } : {})}
            />
          ))}
        </div>
      )}
      {outcome.kind === "success" ? (
        <pre
          className={cn(
            "tf-num max-h-[420px] overflow-auto px-3 py-2.5 text-2xs leading-4",
            "break-words whitespace-pre-wrap text-fg-2"
          )}
        >
          {pretty(outcome.result.output)}
        </pre>
      ) : (
        <p
          role="alert"
          className="flex items-start gap-2 px-3 py-2.5 text-xs break-words whitespace-pre-wrap text-fail"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 flex-none" />
          <span className="min-w-0">{outcome.message}</span>
        </p>
      )}
    </section>
  );
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
