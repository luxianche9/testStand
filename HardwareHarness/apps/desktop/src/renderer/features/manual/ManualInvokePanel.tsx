import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HardwareAvailability, ToolCatalogItem } from "@hardwareharness/contracts/devices";
import { isHardwareExecuting, type ManualToolInvocationResult } from "@hardwareharness/contracts/execution";
import { ChevronRightIcon, CircleAlertIcon, PlayIcon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";
import { useDashboard } from "../../shared/queries.js";
import { queryKeys } from "../../shared/query-keys.js";
import { Badge, badgeVariantFromTone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { cn } from "../../shared/ui/cn";
import { SchemaArgumentsForm } from "./SchemaForm.js";
import { initialSchemaValue, validateSchemaArguments } from "./schema-form-model.js";

export function ManualInvokePanel({ hardwareId }: { hardwareId: string }) {
  const client = useQueryClient();
  const dashboard = useDashboard();

  const tools = useMemo(() => {
    const serverId = dashboard.data?.servers.find((item) => item.hardwareId === hardwareId)?.serverId
      ?? dashboard.data?.hardware.find((item) => item.hardwareId === hardwareId)?.serverId;
    return (dashboard.data?.tools ?? []).filter((item) => item.serverId === serverId);
  }, [dashboard.data, hardwareId]);

  const availability = availabilityFor(hardwareId, dashboard.data?.availability ?? []);
  const runBusy = isHardwareExecuting(dashboard.data?.execution, hardwareId, "run");

  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.dashboard }); };
    const stopExecution = window.hardwareharness.events.subscribe("execution", refresh);
    const stopAvailability = window.hardwareharness.events.subscribe("availability", refresh);
    return () => { stopExecution(); stopAvailability(); };
  }, [client]);

  return <section className="grid gap-3">
    <header className="flex items-center justify-between gap-3">
      <h3 className="m-0 text-sm font-semibold">MCP 工具</h3>
      <Badge variant={badgeVariantFromTone(availabilityTone(availability))}>{availability}</Badge>
    </header>
    {runBusy && <div className={alertClass}><CircleAlertIcon className="size-4" /><span>自动测试 Run 正在使用此硬件，手动调用已禁用。</span></div>}
    {availability !== "available" && <div className="flex items-start gap-1.5 text-[11px] leading-normal text-muted-foreground"><CircleAlertIcon className="mt-0.5 size-3.5 flex-none" /><span>硬件当前为 {availability}，恢复在线后才能执行硬件工具。</span></div>}
    {availability === "available" && !tools.length && <p className="m-0 text-xs text-muted-foreground">该 Server 尚未暴露可用的 MCP 工具。MCP 在线后会自动列出。</p>}
    {!tools.length && availability !== "available" && <p className="m-0 text-xs text-muted-foreground">MCP 在线后会列出该 Server 暴露的工具。</p>}
    <div className="grid gap-2">
      {tools.map((tool) => (
        <McpToolOperation
          key={tool.externalName}
          tool={tool}
          hardwareId={hardwareId}
          availability={availability}
          runBusy={runBusy}
        />
      ))}
    </div>
  </section>;
}

function McpToolOperation({ tool, hardwareId, availability, runBusy }: {
  tool: ToolCatalogItem;
  hardwareId: string;
  availability: HardwareAvailability["state"];
  runBusy: boolean;
}) {
  const client = useQueryClient();
  const dashboard = useDashboard();
  const [open, setOpen] = useState(false);
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>(() => asObject(initialSchemaValue(tool.inputSchema)));
  const [formValid, setFormValid] = useState(true);
  const [result, setResult] = useState<ManualToolInvocationResult>();
  const [callError, setCallError] = useState<{ message: string; durationMs: number }>();
  const startedRef = useRef(0);
  const displaySchema = tool.inputSchema;
  const requiresHardwareGate = tool.kind === "hardware";
  const manualBusy = isHardwareExecuting(dashboard.data?.execution, hardwareId, "manual");
  const hardwareReady = !requiresHardwareGate || availability === "available";
  const validation = useMemo(() => validateSchemaArguments(displaySchema, argumentsValue), [argumentsValue, displaySchema]);

  useEffect(() => {
    setArgumentsValue(asObject(initialSchemaValue(tool.inputSchema)));
    setFormValid(true);
    setResult(undefined);
    setCallError(undefined);
  }, [tool.inputSchema, hardwareId, tool.externalName]);

  const invoke = useMutation({
    mutationFn: () => {
      startedRef.current = performance.now();
      setCallError(undefined);
      setResult(undefined);
      return window.hardwareharness.manual.invokeTool({ hardwareId, toolName: tool.externalName, arguments: argumentsValue, timeoutMs: 30_000 });
    },
    onSuccess: (value) => { setResult(value); void client.invalidateQueries({ queryKey: queryKeys.dashboard }); },
    onError: (value) => {
      setCallError({ message: errorMessage(value), durationMs: Math.max(0, Math.round(performance.now() - startedRef.current)) });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    }
  });

  return <article className={cn("overflow-hidden rounded-lg bg-card shadow-sm ring-1 ring-border", open && "ring-foreground/20")}>
    <button type="button" aria-expanded={open} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/60" onClick={() => setOpen((current) => !current)}>
      <Badge variant={tool.kind === "hardware" ? "success" : "secondary"} className="rounded-sm font-mono uppercase">{tool.kind === "hardware" ? "MCP" : tool.kind}</Badge>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{tool.remoteName}</span>
        <small className="block truncate font-mono text-[11px] text-muted-foreground">{tool.externalName}</small>
      </span>
      <ChevronRightIcon className={cn("size-4 flex-none text-muted-foreground transition-transform", open && "rotate-90")} />
    </button>
    {open && <div className="grid gap-3 border-t border-border px-3 pt-3 pb-3.5">
      {tool.description && <p className="m-0 text-xs text-muted-foreground">{tool.description}</p>}
      <SchemaArgumentsForm schema={displaySchema} value={argumentsValue} onChange={setArgumentsValue} onValidityChange={setFormValid} />
      {validation.errors.length > 0 && <div className="flex flex-col gap-1.5 rounded-md border border-destructive/50 p-2.5"><strong className="text-xs">参数校验</strong>{validation.errors.map((message, index) => <div key={index} className="grid grid-cols-[auto_1fr] gap-1.5 text-[11px]"><code className="text-destructive">input</code><span>{message}</span></div>)}</div>}
      <div className="flex items-center gap-2.5">
        <Button disabled={!hardwareReady || !formValid || !validation.valid || runBusy || manualBusy || invoke.isPending} onClick={() => invoke.mutate()}>
          <PlayIcon />{invoke.isPending ? "正在执行…" : "执行一次"}
        </Button>
        <span className="text-[11px] text-muted-foreground">超时 30 秒 · 硬件上下文由 HardwareHarness 通过协议元数据传递</span>
      </div>
      {(result || callError) && <section className={cn("overflow-hidden rounded-xl bg-secondary/40 ring-1 ring-border", callError && "ring-destructive/55")}>
        <header className="flex items-center justify-between bg-secondary/50 px-2.5 py-2 text-xs"><strong>{callError ? "调用失败" : "调用成功"}</strong><span className="text-muted-foreground">{callError ? `${callError.durationMs} ms` : `${result!.durationMs} ms`}</span></header>
        {callError
          ? <div className={cn(alertClass, "m-3")}><CircleAlertIcon className="size-4" /><span>{callError.message}</span></div>
          : <pre className="m-0 max-h-[420px] overflow-auto p-3 font-mono text-[11px] break-words whitespace-pre-wrap">{pretty(result!.output)}</pre>}
      </section>}
    </div>}
  </article>;
}

const alertClass = "flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none";

function availabilityFor(hardwareId: string, availability: HardwareAvailability[]): HardwareAvailability["state"] {
  return availability.find((item) => item.hardwareId === hardwareId)?.state ?? "checking";
}
function availabilityTone(state: HardwareAvailability["state"]): Parameters<typeof badgeVariantFromTone>[0] {
  return state === "available" ? "ok" : state === "faulted" ? "bad" : state === "checking" ? "accent" : "muted";
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function pretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
