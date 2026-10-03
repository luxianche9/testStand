import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { AgentToolInfo } from "@teststand/contracts/agents";
import { ChevronRightIcon, DownloadIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { useAgentTools } from "../../lib/queries.js";
import { Badge, Button, Spinner, cn, useToast } from "../../ui";
import { Disclosure } from "./SettingsLayout.js";

/** Every tool the gateway will let an agent call, builtin first then per-device, with a one-click
 *  JSON export of the same catalog the MCP `tools/list` response is built from. */
export function AgentToolsSection() {
  const toast = useToast();
  const tools = useAgentTools();
  const [exportedPath, setExportedPath] = useState<string>();
  const items = tools.data ?? [];
  const exportTools = useMutation({
    mutationFn: () => window.teststand.dialogs.exportText(
      "teststand-tools.json",
      JSON.stringify(items, null, 2)
    ),
    onSuccess: (path) => setExportedPath(path ?? undefined),
    onError: (reason) => toast.error(errorMessage(reason))
  });

  return (
    <Disclosure title="可调用的工具" meta={<Badge mono>{items.length}</Badge>}>
      <div className="flex h-9 items-center gap-2 border-b border-line px-3">
        <Button
          variant="ghost"
          size="xs"
          disabled={!items.length || exportTools.isPending}
          onClick={() => exportTools.mutate()}
        >
          <DownloadIcon />
          导出工具清单
        </Button>
        {exportedPath && <span className="truncate font-mono text-2xs text-fg-3">已导出到 {exportedPath}</span>}
      </div>
      {tools.isLoading && (
        <div className="grid place-items-center py-6 text-fg-3"><Spinner label="正在加载工具…" /></div>
      )}
      {tools.isError && <p className="px-3 py-3 text-xs text-fail">{errorMessage(tools.error)}</p>}
      <ul className="max-h-[420px] overflow-y-auto">
        {items.map((tool) => <AgentToolRow key={`${tool.kind}:${tool.name}`} tool={tool} />)}
      </ul>
    </Disclosure>
  );
}

function AgentToolRow({ tool }: { tool: AgentToolInfo }) {
  const [open, setOpen] = useState(false);
  const schemaClass = cn(
    "m-0 max-h-64 overflow-auto border-t border-line bg-surface-0 px-3 py-2",
    "font-mono text-2xs text-fg-2"
  );
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none transition-colors duration-120",
          "hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-fg-3 transition-transform", open && "rotate-90")}
        />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate font-mono text-xs text-fg">{tool.name}</span>
          {tool.description && <span className="truncate text-xs text-fg-3">{tool.description}</span>}
        </span>
        <Badge tone={tool.kind === "builtin" ? "signal" : "neutral"} mono={tool.kind !== "builtin"}>
          {tool.kind === "builtin" ? "内建" : tool.deviceId}
        </Badge>
      </button>
      {open && (
        <pre className={schemaClass}>
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      )}
    </li>
  );
}
