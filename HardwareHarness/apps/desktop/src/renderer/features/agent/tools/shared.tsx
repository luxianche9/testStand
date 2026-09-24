import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn, StatusLamp, type Tone } from "../../../ui";

export type ToolCallStatusLike = { type: string; reason?: string } | undefined;
export const truncate = (value: string, max = 80) => value.length > max ? `${value.slice(0, max - 3)}...` : value;
export const str = (value: unknown) => typeof value === "string" ? value : "";
export const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
export const isCancelledToolStatus = (status?: ToolCallStatusLike) =>
  status?.type === "incomplete" && status.reason === "cancelled";

export function getPatchInfo(patchText: string) {
  if (!patchText) return { files: [] as string[], added: 0, removed: 0 };
  const files = [...new Set(
    [...patchText.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gm)]
      .map((match) => basename(match[1]!.trim()))
      .filter(Boolean)
  )];
  let added = 0;
  let removed = 0;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { files, added, removed };
}

/** Maps a tool-call status onto lamp tones. `failed` marks a completed call with a bad result. */
export function toolTone(status?: ToolCallStatusLike, failed = false): Tone {
  const type = status?.type ?? "complete";
  if (type === "running") return "run";
  if (type === "requires-action") return "signal";
  if (type === "incomplete") return isCancelledToolStatus(status) ? "neutral" : "fail";
  return failed ? "fail" : "pass";
}

export function ToolLamp({ status, failed, className }: {
  status?: ToolCallStatusLike;
  failed?: boolean;
  className?: string;
}) {
  const tone = toolTone(status, failed);
  return <StatusLamp tone={tone} pulse={tone === "run"} {...(className ? { className } : {})} />;
}

/** Hairline-framed panel every tool call renders in. */
export const toolCardClass = "w-full min-w-0 overflow-hidden rounded-md border border-line bg-surface-0/40";

/** The one-line header row of a tool card (also used as the collapsible trigger). */
export const toolRowClass = cn(
  "flex h-7 w-full min-w-0 items-center gap-2 px-2 text-start text-xs text-fg-2 outline-none",
  "transition-colors duration-120 enabled:hover:bg-surface-2 enabled:hover:text-fg",
  "focus-visible:bg-surface-2 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal"
);

/** Tool name in mono plus an optional weak detail (path, pattern, command). */
export function ToolHeading({ name, detail, cancelled, prose, children }: {
  name: ReactNode;
  detail?: ReactNode;
  cancelled?: boolean;
  /** Render the detail in the body font (natural-language summaries). */
  prose?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-1.5 truncate", cancelled && "line-through opacity-50")}>
      <span className="shrink-0 font-mono font-medium text-fg">{name}</span>
      {detail && <span className={cn("truncate text-fg-3", !prose && "font-mono")}>{detail}</span>}
      {children}
    </span>
  );
}

export function ToolChevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn("size-3.5 shrink-0 text-fg-3 transition-transform duration-120", open && "rotate-90")}
    />
  );
}

/** Collapsible body area below a tool row. */
export const toolBodyClass = cn(
  "overflow-hidden border-t border-line",
  "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none"
);

/** Mono output block (args, stdout, results). */
export const toolPreClass = cn(
  "max-h-64 overflow-auto rounded-sm border border-line bg-surface-0 p-2 font-mono text-xs leading-5",
  "whitespace-pre-wrap text-fg-2 wrap-break-word"
);
