import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { PatchDiff } from "@pierre/diffs/react";
import { memo, useMemo, useState } from "react";
import { Collapsible } from "radix-ui";
import {
  getPatchInfo,
  isCancelledToolStatus,
  str,
  toolBodyClass,
  toolCardClass,
  ToolChevron,
  ToolHeading,
  ToolLamp,
  toolRowClass
} from "./shared";

type PatchBlock = { type: string; path: string; body: string };

function parsePatchBlocks(patchText: string): PatchBlock[] {
  const cleaned = patchText
    .replace(/^\*\*\*\s*Begin Patch\s*$/gm, "")
    .replace(/^\*\*\*\s*End Patch\s*$/gm, "")
    .trim();
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
  const lines = block.body.split("\n").filter((line) =>
    !/^@@.*@@\s*$/.test(line) && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")));
  const oldCount = lines.filter((line) => !line.startsWith("+")).length;
  const newCount = lines.filter((line) => !line.startsWith("-")).length;
  const header = `diff --git a/${block.path} b/${block.path}`;
  if (block.type === "Add") {
    const added = lines.map((line) => line.startsWith("+") ? line : `+${line}`);
    return [
      header, "new file mode 100644", "--- /dev/null", `+++ b/${block.path}`,
      `@@ -0,0 +1,${added.length} @@`, added.join("\n")
    ].join("\n");
  }
  if (block.type === "Delete") {
    const removed = lines.map((line) => line.startsWith("-") ? line : `-${line}`);
    return [
      header, "deleted file mode 100644", `--- a/${block.path}`, "+++ /dev/null",
      `@@ -1,${removed.length} +0,0 @@`, removed.join("\n")
    ].join("\n");
  }
  return [
    header, `--- a/${block.path}`, `+++ b/${block.path}`, `@@ -1,${oldCount} +1,${newCount} @@`, lines.join("\n")
  ].join("\n");
}

const diffOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  diffStyle: "unified",
  overflow: "wrap"
} as const;

export const ApplyPatchDiff: ToolCallMessagePartComponent = memo(({ toolName, args, status }) => {
  const [open, setOpen] = useState(false);
  const patchText = str(args?.patchText) || str(args?.patch);
  const info = useMemo(() => getPatchInfo(patchText), [patchText]);
  const unified = useMemo(() => parsePatchBlocks(patchText).map(blockToUnified).join("\n"), [patchText]);
  const running = status?.type === "running";
  const hasDiff = Boolean(unified) && !running;
  const files = info.files.length === 1 ? info.files[0] : info.files.length ? `${info.files.length} 个文件` : undefined;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={toolCardClass}>
      <Collapsible.Trigger className={toolRowClass} disabled={!hasDiff}>
        <ToolLamp status={status} />
        <ToolHeading name={toolName} detail={files} cancelled={isCancelledToolStatus(status)} />
        {(info.added > 0 || info.removed > 0) && !running && (
          <span className="tf-num flex shrink-0 items-center gap-1.5 text-2xs">
            {!!info.added && <span className="text-pass">+{info.added}</span>}
            {!!info.removed && <span className="text-fail">-{info.removed}</span>}
          </span>
        )}
        {hasDiff && <ToolChevron open={open} />}
      </Collapsible.Trigger>
      {hasDiff && (
        <Collapsible.Content className={toolBodyClass}>
          <div className="max-h-[28rem] overflow-auto text-xs">
            <PatchDiff patch={unified} options={diffOptions} />
          </div>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
});
ApplyPatchDiff.displayName = "ApplyPatchDiff";
