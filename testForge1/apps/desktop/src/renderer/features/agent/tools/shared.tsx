import { AlertCircleIcon, CheckIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../utils";

export type ToolCallStatusLike = { type: string; reason?: string } | undefined;
export const truncate = (value: string, max = 80) => value.length > max ? `${value.slice(0, max - 3)}...` : value;
export const str = (value: unknown) => typeof value === "string" ? value : "";
export const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
export const isCancelledToolStatus = (status?: ToolCallStatusLike) => status?.type === "incomplete" && status.reason === "cancelled";

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

export function ToolStatusIcon({ status, completeIcon }: { status?: ToolCallStatusLike; completeIcon?: ReactNode }) {
  const type = status?.type ?? "complete";
  const cancelled = isCancelledToolStatus(status);
  if (type === "running") return <LoaderIcon className="size-3 shrink-0 animate-spin" />;
  if (type === "requires-action") return <AlertCircleIcon className="size-3 shrink-0 text-amber-600" />;
  if (type === "incomplete") return <XCircleIcon className={cn("size-3 shrink-0", !cancelled && "text-destructive")} />;
  return completeIcon ?? <CheckIcon className="size-3 shrink-0" />;
}
