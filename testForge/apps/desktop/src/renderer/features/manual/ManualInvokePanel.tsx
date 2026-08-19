import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HardwareAvailability } from "@testforge/contracts/devices";
import { isHardwareExecuting, type ManualToolInvocationResult } from "@testforge/contracts/execution";
import { CircleAlertIcon, PlayIcon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";
import { useDashboard } from "../../shared/queries.js";
import { queryKeys } from "../../shared/query-keys.js";
import { Badge, badgeVariantFromTone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { cn } from "../../shared/ui/cn";
import { EmptyState } from "../../shared/ui/empty-state";
import { SchemaArgumentsForm } from "./SchemaForm.js";
import { initialSchemaValue, validateSchemaArguments } from "./schema-form-model.js";

export function ManualInvokePanel({ hardwareId, preferredToolName }: {
  hardwareId?: string | undefined;
  preferredToolName?: string | undefined;
}) {
  const client = useQueryClient();
  const dashboard = useDashboard();
  const [toolName, setToolName] = useState<string>();
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>({});
  const [formValid, setFormValid] = useState(true);
  const [result, setResult] = useState<ManualToolInvocationResult>();
  const [callError, setCallError] = useState<{ message: string; durationMs: number }>();
  const startedRef = useRef(0);

  const tools = useMemo(() => {
    const serverId = dashboard.data?.servers.find((item) => item.hardwareId === hardwareId)?.serverId
      ?? dashboard.data?.hardware.find((item) => item.hardwareId === hardwareId)?.serverId;
    return (dashboard.data?.tools ?? []).filter((item) => item.kind === "hardware" && item.serverId === serverId);
  }, [dashboard.data, hardwareId]);

  useEffect(() => {
    if (preferredToolName && tools.some((item) => item.externalName === preferredToolName)) {
      setToolName(preferredToolName);
      return;
    }
    if (!toolName || !tools.some((item) => item.externalName === toolName)) setToolName(tools[0]?.externalName);
  }, [preferredToolName, toolName, tools]);

  const selectedTool = tools.find((item) => item.externalName === toolName);
  const displaySchema = selectedTool?.inputSchema;
  useEffect(() => {
    const initial = displaySchema ? initialSchemaValue(displaySchema) : {};
    setArgumentsValue(asObject(initial));
    setFormValid(true);
    setResult(undefined);
    setCallError(undefined);
  }, [displaySchema, hardwareId, toolName]);

  const validation = useMemo(() => selectedTool && hardwareId ? validateSchemaArguments(selectedTool.inputSchema, argumentsValue) : { valid: false, errors: [] }, [argumentsValue, hardwareId, selectedTool]);
  const availability = availabilityFor(hardwareId, dashboard.data?.availability ?? []);
  const runBusy = hardwareId ? isHardwareExecuting(dashboard.data?.execution, hardwareId, "run") : false;
  const manualBusy = hardwareId ? isHardwareExecuting(dashboard.data?.execution, hardwareId, "manual") : false;
  const occupancy = hardwareId ? dashboard.data?.occupancy.find((item) => item.hardwareId === hardwareId) : undefined;
  const occupied = occupancy?.state === "occupied_by_self";
  const invoke = useMutation({
    mutationFn: () => {
      if (!hardwareId || !toolName) throw new Error("请选择硬件和工具");
      startedRef.current = performance.now();
      setCallError(undefined);
      setResult(undefined);
      return window.testforge.manual.invokeTool({ hardwareId, toolName, arguments: argumentsValue, timeoutMs: 30_000 });
    },
    onSuccess: (value) => { setResult(value); void client.invalidateQueries({ queryKey: queryKeys.dashboard }); },
    onError: (value) => {
      setCallError({ message: errorMessage(value), durationMs: Math.max(0, Math.round(performance.now() - startedRef.current)) });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    }
  });

  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.dashboard }); };
    const stopExecution = window.testforge.events.subscribe("execution", refresh);
    const stopAvailability = window.testforge.events.subscribe("availability", refresh);
    const stopOccupancy = window.testforge.events.subscribe("occupancy", refresh);
    return () => { stopExecution(); stopAvailability(); stopOccupancy(); };
  }, [client]);

  if (!hardwareId) {
    return <EmptyState className="m-auto" title="选择一个 MCP Server 或硬件工具" body="在左侧树中点选受管硬件对应的 Server，即可在此手动调用。" />;
  }

  return <div className="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)]">
    <aside className="flex min-h-0 flex-col overflow-auto border-r bg-card">
      <header className="flex min-h-[58px] items-center justify-between border-b px-3 py-2.5"><strong className="text-sm font-semibold">硬件工具</strong><span className="text-xs text-muted-foreground">{tools.length}</span></header>
      {tools.map((tool) => <button
        key={tool.externalName}
        type="button"
        disabled={invoke.isPending}
        className={cn(
          "flex-none cursor-pointer border-0 border-b bg-transparent px-3 py-2.5 text-left text-foreground hover:bg-accent",
          tool.externalName === toolName && "bg-accent shadow-[inset_2px_0_0_var(--primary)]"
        )}
        onClick={() => setToolName(tool.externalName)}
      ><strong className="block truncate text-sm font-medium">{tool.remoteName}</strong><small className="mt-0.5 block truncate text-[11px] text-muted-foreground">{tool.description || tool.externalName}</small></button>)}
      {availability !== "available" && <div className="flex items-start gap-1.5 px-3 py-3.5 text-[11px] leading-normal text-muted-foreground"><CircleAlertIcon className="mt-0.5 size-3.5 flex-none" /><span>硬件当前为 {availability}，恢复在线后才能执行。</span></div>}
      {availability === "available" && !tools.length && <div className="flex items-start gap-1.5 px-3 py-3.5 text-[11px] leading-normal text-muted-foreground">该 Server 未暴露 hardware 工具。</div>}
    </aside>
    <section className="min-h-0 min-w-0 overflow-auto px-5 pt-4 pb-9">
      {selectedTool && displaySchema ? <>
        <header className="mb-2.5 flex items-center justify-between gap-3">
          <span className="min-w-0"><h2 className="m-0 text-lg font-semibold">{selectedTool.remoteName}</h2><small className="mt-1 block font-mono text-[11px] text-muted-foreground">{selectedTool.externalName}</small></span>
          <Badge variant={badgeVariantFromTone(availabilityTone(availability))}>{availability}</Badge>
        </header>
        {selectedTool.description && <p className="mt-0 text-xs text-muted-foreground">{selectedTool.description}</p>}
        {runBusy && <div className={alertClass}><CircleAlertIcon className="size-4" /><span>自动测试 Run 正在使用此硬件，手动调用已禁用。</span></div>}
        {!occupied && <div className={alertClass}><CircleAlertIcon className="size-4" /><span>{occupancy?.state === "occupied_elsewhere" ? `硬件已被 ${occupancy.holderLabel ?? "其他客户端"} 占用。` : "请先在设备管理树中由人工点击“占用硬件”，再执行手动调用。"}</span></div>}
        <SchemaArgumentsForm schema={displaySchema} value={argumentsValue} onChange={setArgumentsValue} onValidityChange={setFormValid} />
        {validation.errors.length > 0 && <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-destructive/50 p-2.5"><strong className="text-xs">参数校验</strong>{validation.errors.map((message, index) => <div key={index} className="grid grid-cols-[auto_1fr] gap-1.5 text-[11px]"><code className="text-destructive">input</code><span>{message}</span></div>)}</div>}
        <div className="mt-3.5 flex items-center gap-2.5 border-t pt-3"><Button disabled={!occupied || !formValid || !validation.valid || availability !== "available" || runBusy || manualBusy || invoke.isPending} onClick={() => invoke.mutate()}><PlayIcon />{invoke.isPending ? "正在执行…" : "执行一次"}</Button><span className="text-[11px] text-muted-foreground">超时 30 秒 · 硬件上下文由 TestForge 通过协议元数据传递</span></div>
        {(result || callError) && <section className={cn("mt-4 overflow-hidden rounded-md border", callError && "border-destructive/55")}>
          <header className="flex items-center justify-between bg-secondary/50 px-2.5 py-2 text-xs"><strong>{callError ? "调用失败" : "调用成功"}</strong><span className="text-muted-foreground">{callError ? `${callError.durationMs} ms` : `${result!.durationMs} ms`}</span></header>
          {callError
            ? <div className={cn(alertClass, "m-3")}><CircleAlertIcon className="size-4" /><span>{callError.message}</span></div>
            : <pre className="m-0 max-h-[420px] overflow-auto p-3 font-mono text-[11px] break-words whitespace-pre-wrap">{pretty(result!.output)}</pre>}
        </section>}
      </> : <EmptyState title="选择一个硬件工具" body="参数表单会根据 MCP 工具的 JSON Schema 自动生成。" />}
    </section>
  </div>;
}

const alertClass = "mt-3 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none";

function availabilityFor(hardwareId: string | undefined, availability: HardwareAvailability[]): HardwareAvailability["state"] {
  if (!hardwareId) return "unavailable";
  return availability.find((item) => item.hardwareId === hardwareId)?.state ?? "checking";
}
function availabilityTone(state: HardwareAvailability["state"]): Parameters<typeof badgeVariantFromTone>[0] { return state === "available" ? "ok" : state === "faulted" ? "bad" : state === "checking" ? "accent" : "muted"; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
