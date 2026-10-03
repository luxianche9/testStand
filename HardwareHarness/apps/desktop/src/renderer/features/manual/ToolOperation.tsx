import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HardwareAvailability, ToolCatalogItem } from "@hardwareharness/contracts/devices";
import { isHardwareExecuting } from "@hardwareharness/contracts/execution";
import { ChevronRightIcon, PlayIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { useDashboard } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Badge, Button, cn, Spinner } from "../../ui";
import { InvocationResult, type InvocationOutcome } from "./InvocationResult.js";
import { SchemaArgumentsForm } from "./SchemaForm.js";
import { initialSchemaValue } from "./schema-form-model.js";
import { validateSchemaArguments } from "./schema-validation.js";

const TIMEOUT_MS = 30_000;

/** One MCP tool: collapsible header, schema-driven arguments, a single-shot invoke and its readout. */
export function ToolOperation({ tool, hardwareId, availability }: {
  tool: ToolCatalogItem;
  hardwareId: string;
  availability: HardwareAvailability["state"];
}) {
  const client = useQueryClient();
  const dashboard = useDashboard();
  const [open, setOpen] = useState(false);
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>(
    () => asObject(initialSchemaValue(tool.inputSchema))
  );
  const [formValid, setFormValid] = useState(true);
  const [outcome, setOutcome] = useState<InvocationOutcome>();
  const startedRef = useRef(0);
  const schema = tool.inputSchema;
  const manualBusy = isHardwareExecuting(dashboard.data?.execution, hardwareId, "manual");
  const hardwareReady = tool.kind !== "hardware" || availability === "available";
  const validation = useMemo(() => validateSchemaArguments(schema, argumentsValue), [argumentsValue, schema]);

  useEffect(() => {
    setArgumentsValue(asObject(initialSchemaValue(tool.inputSchema)));
    setFormValid(true);
    setOutcome(undefined);
  }, [tool.inputSchema, hardwareId, tool.externalName]);

  const invoke = useMutation({
    mutationFn: () => {
      startedRef.current = performance.now();
      setOutcome(undefined);
      return window.hardwareharness.manual.invokeTool({
        raw: { hardwareId, toolName: tool.externalName, arguments: argumentsValue, timeoutMs: TIMEOUT_MS }
      });
    },
    onSuccess: (result) => setOutcome({ kind: "success", result }),
    onError: (value) => {
      const durationMs = Math.max(0, Math.round(performance.now() - startedRef.current));
      setOutcome({ kind: "failure", message: errorMessage(value), durationMs });
    },
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.dashboard })
  });
  const disabled = !hardwareReady || !formValid || !validation.valid || manualBusy || invoke.isPending;

  return (
    <article className={cn("rounded-md border border-line bg-surface-1", open && "border-line-strong")}>
      {/* No aria-label: the accessible name comes from the tool names so /write_voltage/ matches it. */}
      <button
        type="button"
        aria-expanded={open}
        className={cn(
          "flex h-9 w-full items-center gap-2 px-2.5 text-left outline-none transition-colors duration-120",
          "hover:bg-surface-2 focus-visible:bg-surface-2"
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRightIcon
          className={cn("size-3.5 flex-none text-fg-3 transition-transform duration-120", open && "rotate-90")}
        />
        <Badge tone={tool.kind === "hardware" ? "signal" : "neutral"}>
          {tool.kind === "hardware" ? "设备" : "管理"}
        </Badge>
        <span className="min-w-0 truncate text-sm font-medium text-fg">{tool.remoteName}</span>
        <span className="tf-num min-w-0 flex-1 truncate text-2xs text-fg-3">{tool.externalName}</span>
      </button>
      {open && (
        <div className="grid gap-3 border-t border-line px-3 py-3">
          {tool.description && <p className="text-xs text-fg-2">{tool.description}</p>}
          <SchemaArgumentsForm
            schema={schema}
            value={argumentsValue}
            onChange={setArgumentsValue}
            onValidityChange={setFormValid}
          />
          {validation.errors.length > 0 && (
            <div className="grid gap-1 rounded-md border border-invalid/40 bg-invalid/10 px-2.5 py-2">
              <strong className="tf-label text-invalid">参数校验</strong>
              {validation.errors.map((message, index) => (
                <div key={index} className="grid grid-cols-[auto_1fr] gap-1.5 text-xs">
                  <code className="tf-num text-invalid">input</code>
                  <span className="text-fg-2">{message}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="primary" size="sm" disabled={disabled} onClick={() => invoke.mutate()}>
              {invoke.isPending ? <Spinner /> : <PlayIcon />}
              {invoke.isPending ? "正在执行…" : "执行一次"}
            </Button>
            <span className="text-2xs text-fg-3">超时 30 秒 · 硬件上下文由 HardwareHarness 通过协议元数据传递</span>
          </div>
          {outcome && <InvocationResult outcome={outcome} />}
        </div>
      )}
    </article>
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
