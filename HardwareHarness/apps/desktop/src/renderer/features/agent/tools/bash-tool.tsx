import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ChevronRightIcon, DollarSignIcon, XCircleIcon } from "lucide-react";
import { memo, useState } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsibleContent = CollapsiblePrimitive.Content;
import { cn } from "../../../shared/ui/index.js";
import { ToolStatusIcon, isCancelledToolStatus, truncate } from "./shared";

function parseResult(result: unknown): Record<string, unknown> {
  if (!result) return {};
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed === "object" && parsed) return parsed as Record<string, unknown>;
    } catch { /* plain text */ }
    return { stdout: result };
  }
  return typeof result === "object" ? result as Record<string, unknown> : {};
}

export const BashTerminal: ToolCallMessagePartComponent = memo(({ args, result, status }) => {
  const [open, setOpen] = useState(false);
  const command = typeof args?.command === "string" ? args.command : "";
  const description = typeof args?.description === "string" ? args.description : "";
  const running = status?.type === "running";
  const cancelled = isCancelledToolStatus(status);
  const parsed = running ? {} : parseResult(result);
  const stdout = typeof parsed.stdout === "string" ? parsed.stdout : undefined;
  const stderr = typeof parsed.stderr === "string" ? parsed.stderr : undefined;
  const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
  const output = Boolean(stdout || stderr);
  const error = !running && exitCode !== 0;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="group flex w-full items-center gap-2 py-0.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40">
          {running ? <ToolStatusIcon status={status} /> : error ? <XCircleIcon className="size-3 shrink-0 text-destructive" /> : <ToolStatusIcon status={status} completeIcon={<DollarSignIcon className="size-3.5 shrink-0" />} />}
          <span className={cn("flex min-w-0 items-center gap-1.5 truncate", cancelled && "line-through opacity-50")}><span className="font-medium">bash</span>{(description || command) && <span className="truncate opacity-60">{description || truncate(command)}</span>}</span>
          {output && <><span className="mt-0.5 min-w-4 flex-1 self-center border-b-[0.5px] border-muted-foreground/20" /><ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} /></>}
        </button>
      </CollapsibleTrigger>
      {output && (
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="mt-1 ml-5 max-h-96 overflow-y-auto rounded-xl bg-muted/50 p-3 font-mono text-xs shadow-sm ring-1 ring-border">
            {command && <div className="mb-2 text-muted-foreground">$ {command}</div>}
            {stdout && <pre className="whitespace-pre-wrap text-foreground wrap-break-word">{stdout}</pre>}
            {stderr && <pre className={cn("whitespace-pre-wrap text-destructive wrap-break-word", stdout && "mt-2")}>{stderr}</pre>}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
});
BashTerminal.displayName = "BashTerminal";
