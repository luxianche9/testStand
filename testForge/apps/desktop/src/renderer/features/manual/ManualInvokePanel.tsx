import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HardwareAvailability } from "@testforge/contracts/devices";
import { isHardwareExecuting, type ManualToolInvocationResult } from "@testforge/contracts/execution";
import { IconAlert, IconPlay } from "../../shared/icons.js";
import { errorMessage } from "../../shared/errors.js";
import { Badge, type BadgeTone, Btn, EmptyState } from "../../shared/ui.js";
import { useDashboard } from "../../shared/queries.js";
import { queryKeys } from "../../shared/query-keys.js";
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
    return () => { stopExecution(); stopAvailability(); };
  }, [client]);

  if (!hardwareId) {
    return <EmptyState title="选择一个 MCP Server 或硬件工具" body="在左侧树中点选受管硬件对应的 Server，即可在此手动调用。" />;
  }

  return <div className="manual-invoke">
    <aside className="manual-tool-panel">
      <header><strong>硬件工具</strong><span>{tools.length}</span></header>
      {tools.map((tool) => <button key={tool.externalName} disabled={invoke.isPending} className={tool.externalName === toolName ? "active" : ""} onClick={() => setToolName(tool.externalName)}><strong>{tool.remoteName}</strong><small>{tool.description || tool.externalName}</small></button>)}
      {availability !== "available" && <div className="manual-tool-empty"><IconAlert size={15} /><span>硬件当前为 {availability}，恢复在线后才能执行。</span></div>}
      {availability === "available" && !tools.length && <div className="manual-tool-empty">该 Server 未暴露 hardware 工具。</div>}
    </aside>
    <section className="manual-call-panel">
      {selectedTool && displaySchema ? <>
        <header className="manual-call-head"><span><h2>{selectedTool.remoteName}</h2><small>{selectedTool.externalName}</small></span><Badge tone={availabilityTone(availability)}>{availability}</Badge></header>
        {selectedTool.description && <p className="muted-copy">{selectedTool.description}</p>}
        {runBusy && <div className="alert"><IconAlert size={15} /><span>自动测试 Run 正在使用此硬件，手动调用已禁用。</span></div>}
        <SchemaArgumentsForm schema={displaySchema} value={argumentsValue} onChange={setArgumentsValue} onValidityChange={setFormValid} />
        {validation.errors.length > 0 && <div className="validation-box invalid"><strong>参数校验</strong>{validation.errors.map((message, index) => <div key={index}><code>input</code><span>{message}</span></div>)}</div>}
        <div className="manual-call-actions"><Btn variant="primary" icon={<IconPlay size={13} />} disabled={!formValid || !validation.valid || availability !== "available" || runBusy || manualBusy || invoke.isPending} onClick={() => invoke.mutate()}>{invoke.isPending ? "正在执行…" : "执行一次"}</Btn><span>超时 30 秒 · 硬件上下文由 TestForge 通过协议元数据传递</span></div>
        {(result || callError) && <section className={`manual-result${callError ? " failed" : ""}`}><header><strong>{callError ? "调用失败" : "调用成功"}</strong><span>{callError ? `${callError.durationMs} ms` : `${result!.durationMs} ms`}</span></header>{callError ? <div className="alert"><IconAlert size={15} /><span>{callError.message}</span></div> : <pre>{pretty(result!.output)}</pre>}</section>}
      </> : <EmptyState title="选择一个硬件工具" body="参数表单会根据 MCP 工具的 JSON Schema 自动生成。" />}
    </section>
  </div>;
}

function availabilityFor(hardwareId: string | undefined, availability: HardwareAvailability[]): HardwareAvailability["state"] {
  if (!hardwareId) return "unavailable";
  return availability.find((item) => item.hardwareId === hardwareId)?.state ?? "checking";
}
function availabilityTone(state: HardwareAvailability["state"]): BadgeTone { return state === "available" ? "ok" : state === "faulted" ? "bad" : state === "checking" ? "accent" : "muted"; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
