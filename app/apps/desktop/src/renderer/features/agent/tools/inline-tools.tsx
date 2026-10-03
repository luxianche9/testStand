import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { memo, type ReactNode } from "react";
import {
  basename,
  isCancelledToolStatus,
  str,
  toolCardClass,
  ToolHeading,
  ToolLamp,
  toolRowClass,
  truncate,
  type ToolCallStatusLike
} from "./shared";

function shortenPath(path: string, depth = 2) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= depth ? path : parts.slice(-depth).join("/");
}

function ToolCallShell({ toolName, status, detail }: {
  toolName: string;
  status?: ToolCallStatusLike;
  detail?: ReactNode;
}) {
  return (
    <div className={toolCardClass}>
      <div className={toolRowClass}>
        <ToolLamp status={status} />
        <ToolHeading name={toolName} detail={detail} cancelled={isCancelledToolStatus(status)} />
      </div>
    </div>
  );
}

function inlineTool(
  argKeys: string | string[],
  format: (value: string) => string = truncate
): ToolCallMessagePartComponent {
  const keys = Array.isArray(argKeys) ? argKeys : [argKeys];
  return memo(({ toolName, args, status }) => {
    const value = keys.reduce<string>(
      (current, key) => current || str((args as Record<string, unknown>)?.[key]),
      ""
    );
    return <ToolCallShell toolName={toolName} status={status} detail={value ? format(value) : undefined} />;
  });
}

export const ReadInline = inlineTool(
  ["file_path", "filePath", "path", "file"],
  (value) => truncate(shortenPath(value))
);
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
