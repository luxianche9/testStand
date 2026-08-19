import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { PatchDiff } from "@pierre/diffs/react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsibleContent = CollapsiblePrimitive.Content;
import { cn } from "../../../shared/ui/index.js";
import { ToolStatusIcon, getPatchInfo, isCancelledToolStatus, str } from "./shared";

type PatchBlock = { type: string; path: string; body: string };

function parsePatchBlocks(patchText: string): PatchBlock[] {
  const cleaned = patchText.replace(/^\*\*\*\s*Begin Patch\s*$/gm, "").replace(/^\*\*\*\s*End Patch\s*$/gm, "").trim();
  const pattern = /^\*\*\*\s+(Update|Add|Delete)\s+File:\s+(.+)$/gm;
  const blocks: PatchBlock[] = [];
  let lastIndex = 0;
  for (const match of cleaned.matchAll(pattern)) {
    if (blocks.length) blocks[blocks.length - 1]!.body = cleaned.slice(lastIndex, match.index);
    blocks.push({ type: match[1]!, path: match[2]!.trim(), body: "" });
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  if (blocks.length) blocks[blocks.length - 1]!.body = cleaned.slice(lastIndex);
  return blocks;
}

function blockToUnified(block: PatchBlock) {
  const lines = block.body.split("\n").filter((line) => !/^@@.*@@\s*$/.test(line) && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")));
  const oldCount = lines.filter((line) => !line.startsWith("+")).length;
  const newCount = lines.filter((line) => !line.startsWith("-")).length;
  if (block.type === "Add") {
    const added = lines.map((line) => line.startsWith("+") ? line : `+${line}`);
    return `diff --git a/${block.path} b/${block.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${block.path}\n@@ -0,0 +1,${added.length} @@\n${added.join("\n")}`;
  }
  if (block.type === "Delete") {
    const removed = lines.map((line) => line.startsWith("-") ? line : `-${line}`);
    return `diff --git a/${block.path} b/${block.path}\ndeleted file mode 100644\n--- a/${block.path}\n+++ /dev/null\n@@ -1,${removed.length} +0,0 @@\n${removed.join("\n")}`;
  }
  return `diff --git a/${block.path} b/${block.path}\n--- a/${block.path}\n+++ b/${block.path}\n@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}`;
}

export const ApplyPatchDiff: ToolCallMessagePartComponent = memo(({ toolName, args, status }) => {
  const [open, setOpen] = useState(false);
  const patchText = str(args?.patchText) || str(args?.patch);
  const info = useMemo(() => getPatchInfo(patchText), [patchText]);
  const unified = useMemo(() => parsePatchBlocks(patchText).map(blockToUnified).join("\n"), [patchText]);
  const running = status?.type === "running";
  const cancelled = isCancelledToolStatus(status);
  const hasDiff = Boolean(unified) && !running;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="group flex w-full items-center gap-2 py-0.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40">
          <ToolStatusIcon status={status} completeIcon={<CheckIcon className="size-3 shrink-0" />} />
          <span className={cn("flex min-w-0 items-center gap-1.5 truncate", cancelled && "line-through opacity-50")}>
            <span className="font-medium">{toolName}</span>
            {!!info.files.length && <span className="truncate opacity-60">{info.files.length === 1 ? info.files[0] : `${info.files.length} 个文件`}</span>}
            {(info.added > 0 || info.removed > 0) && !running && <span className="ml-0.5 flex items-center gap-1 font-mono text-xs">{!!info.added && <span className="text-green-500">+{info.added}</span>}{!!info.removed && <span className="text-red-500">-{info.removed}</span>}</span>}
          </span>
          {hasDiff && <><span className="mt-0.5 min-w-4 flex-1 self-center border-b-[0.5px] border-muted-foreground/20" /><ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} /></>}
        </button>
      </CollapsibleTrigger>
      {hasDiff && (
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="mt-1 ml-5 overflow-hidden rounded-md border text-xs">
            <PatchDiff patch={unified} options={{ theme: { dark: "pierre-dark", light: "pierre-light" }, diffStyle: "unified", overflow: "wrap" }} />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
});
ApplyPatchDiff.displayName = "ApplyPatchDiff";
