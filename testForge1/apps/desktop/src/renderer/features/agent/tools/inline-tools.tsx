import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { memo, useMemo } from "react";
import { cn } from "../utils";
import { ToolStatusIcon, basename, isCancelledToolStatus, str, truncate, type ToolCallStatusLike } from "./shared";

function shortenPath(path: string, depth = 2) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= depth ? path : parts.slice(-depth).join("/");
}

function ToolCallShell({ toolName, status, children }: { toolName: string; status?: ToolCallStatusLike; children?: React.ReactNode }) {
  const cancelled = isCancelledToolStatus(status);
  return (
    <div className="flex items-center gap-2 py-0.5 text-sm text-muted-foreground">
      <ToolStatusIcon status={status} />
      <span className={cn("flex min-w-0 items-center gap-1.5 truncate", cancelled && "line-through opacity-50")}>
        <span className="font-medium">{toolName}</span>{children}
      </span>
    </div>
  );
}

function inlineTool(argKeys: string | string[], format: (value: string) => string = truncate): ToolCallMessagePartComponent {
  const keys = Array.isArray(argKeys) ? argKeys : [argKeys];
  return memo(({ toolName, args, status }) => {
    const value = keys.reduce<string>((current, key) => current || str((args as Record<string, unknown>)?.[key]), "");
    return <ToolCallShell toolName={toolName} status={status}>{value && <span className="truncate opacity-60">{format(value)}</span>}</ToolCallShell>;
  });
}

export const ReadInline = inlineTool(["file_path", "filePath", "path", "file"], (value) => truncate(shortenPath(value)));
export const EditInline = inlineTool(["file_path", "filePath", "path"], basename);
export const WriteInline = inlineTool(["file_path", "filePath", "path"], basename);
export const GrepInline = inlineTool(["pattern", "query"]);
export const GlobInline = inlineTool(["pattern", "glob"]);
export const WebSearchInline = inlineTool(["query", "search"]);
export const WebFetchInline = inlineTool(["url"]);
ReadInline.displayName = "ReadInline";
EditInline.displayName = "EditInline";
WriteInline.displayName = "WriteInline";
GrepInline.displayName = "GrepInline";
GlobInline.displayName = "GlobInline";
WebSearchInline.displayName = "WebSearchInline";
WebFetchInline.displayName = "WebFetchInline";
