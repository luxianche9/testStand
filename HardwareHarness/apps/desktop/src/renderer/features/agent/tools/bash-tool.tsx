import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { memo, useState } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "../../../ui";
import {
  isCancelledToolStatus,
  toolBodyClass,
  toolCardClass,
  ToolChevron,
  ToolHeading,
  ToolLamp,
  toolRowClass,
  truncate
} from "./shared";

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
  const parsed = running ? {} : parseResult(result);
  const stdout = typeof parsed.stdout === "string" ? parsed.stdout : undefined;
  const stderr = typeof parsed.stderr === "string" ? parsed.stderr : undefined;
  const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
  const output = Boolean(stdout || stderr);
  const failed = !running && exitCode !== 0;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={toolCardClass}>
      <Collapsible.Trigger className={toolRowClass} disabled={!output}>
        <ToolLamp status={status} failed={failed} />
        <ToolHeading
          name="bash"
          detail={description || (command ? truncate(command) : undefined)}
          cancelled={isCancelledToolStatus(status)}
        />
        {failed && <span className="tf-num shrink-0 text-2xs text-fail">exit {exitCode}</span>}
        {output && <ToolChevron open={open} />}
      </Collapsible.Trigger>
      {output && (
        <Collapsible.Content className={toolBodyClass}>
          <div className="max-h-96 overflow-y-auto bg-surface-0 px-2.5 py-2 font-mono text-xs leading-5">
            {command && <div className="mb-1.5 text-fg-3"><span className="text-signal">$</span> {command}</div>}
            {stdout && <pre className="whitespace-pre-wrap text-fg wrap-break-word">{stdout}</pre>}
            {stderr && (
              <pre className={cn("whitespace-pre-wrap text-fail wrap-break-word", stdout && "mt-2")}>{stderr}</pre>
            )}
          </div>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
});
BashTerminal.displayName = "BashTerminal";
