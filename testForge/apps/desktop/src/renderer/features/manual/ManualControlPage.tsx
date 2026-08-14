import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Hardware, HardwareAvailability } from "@testforge/contracts/devices";
import type { ManualToolInvocationResult } from "@testforge/contracts/execution";
import { IconAlert, IconChip, IconPlay, IconRefresh } from "../../shared/icons.js";
import { Badge, type BadgeTone, Btn, EmptyState, Spinner } from "../../shared/ui.js";
import { useDashboard, useDeviceCatalog } from "../../shared/queries.js";
import { SchemaArgumentsForm } from "./SchemaForm.js";
import { initialSchemaValue, stripSchemaProperties, validateSchemaArguments } from "./schema-form-model.js";

export function ManualControlPage() {
  const client = useQueryClient();
  const catalog = useDeviceCatalog();
  const dashboard = useDashboard();
  const [hardwareId, setHardwareId] = useState<string>();
  const [toolName, setToolName] = useState<string>();
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>({});
  const [formValid, setFormValid] = useState(true);
  const [result, setResult] = useState<ManualToolInvocationResult>();
  const [callError, setCallError] = useState<{ message: string; durationMs: number }>();
  const startedRef = useRef(0);

  const hardware = useMemo(() => (catalog.data?.hardware ?? []).filter((item): item is Hardware & { kind: "managed"; serverId: string; computerId: string } => item.kind === "managed" && Boolean(item.serverId && item.computerId)), [catalog.data?.hardware]);
  useEffect(() => {
    if (!hardwareId || !hardware.some((item) => item.hardwareId === hardwareId)) setHardwareId(hardware[0]?.hardwareId);
  }, [hardware, hardwareId]);
  const selectedHardware = hardware.find((item) => item.hardwareId === hardwareId);
  const tools = useMemo(() => (dashboard.data?.tools ?? []).filter((item) => item.kind === "hardware" && item.serverId === selectedHardware?.serverId), [dashboard.data?.tools, selectedHardware?.serverId]);
  useEffect(() => {
    if (!toolName || !tools.some((item) => item.externalName === toolName)) setToolName(tools[0]?.externalName);
  }, [toolName, tools]);
  const selectedTool = tools.find((item) => item.externalName === toolName);
  const displaySchema = useMemo(() => selectedTool ? stripSchemaProperties(selectedTool.inputSchema, ["hardwareId"]) : undefined, [selectedTool]);
  useEffect(() => {
    const initial = displaySchema ? initialSchemaValue(displaySchema) : {};
    setArgumentsValue(asObject(initial));
    setFormValid(true);
    setResult(undefined);
    setCallError(undefined);
  }, [displaySchema, hardwareId, toolName]);

  const validation = useMemo(() => selectedTool ? validateSchemaArguments(selectedTool.inputSchema, hardwareId, argumentsValue) : { valid: false, errors: [] }, [argumentsValue, hardwareId, selectedTool]);
  const availability = availabilityFor(hardwareId, dashboard.data?.availability ?? []);
  const runBusy = dashboard.data?.execution.state === "run";
  const manualBusy = dashboard.data?.execution.state === "manual";
  const invoke = useMutation({
    mutationFn: () => {
      if (!hardwareId || !toolName) throw new Error("请选择硬件和工具");
      startedRef.current = performance.now();
      setCallError(undefined);
      setResult(undefined);
      return window.testforge.manual.invokeTool({ hardwareId, toolName, arguments: argumentsValue, timeoutMs: 30_000 });
    },
    onSuccess: (value) => { setResult(value); void client.invalidateQueries({ queryKey: ["dashboard"] }); },
    onError: (value) => {
      setCallError({ message: errorMessage(value), durationMs: Math.max(0, Math.round(performance.now() - startedRef.current)) });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });

  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: ["dashboard"] }); };
    const stopExecution = window.testforge.events.subscribe("execution", refresh);
    const stopAvailability = window.testforge.events.subscribe("availability", refresh);
    return () => { stopExecution(); stopAvailability(); };
  }, [client]);

  if (catalog.isLoading || dashboard.isLoading) return <div className="centered"><Spinner label="正在加载受管硬件…" /></div>;
  return <main className="manual-page">
    <aside className="manual-hardware-panel">
      <header className="feature-heading"><span><h1>手动控制</h1><small>一次调用一个 MCP 硬件工具</small></span><Btn variant="subtle" icon={<IconRefresh size={14} />} aria-label="刷新硬件状态" onClick={() => { void catalog.refetch(); void dashboard.refetch(); }} /></header>
      <div className="manual-hardware-list">
        {hardware.map((item) => {
          const state = availabilityFor(item.hardwareId, dashboard.data?.availability ?? []);
          return <button key={item.hardwareId} disabled={invoke.isPending} className={item.hardwareId === hardwareId ? "active" : ""} onClick={() => setHardwareId(item.hardwareId)}><IconChip size={16} /><span><strong>{item.label}</strong><small>{item.hardwareId}</small></span><Badge tone={availabilityTone(state)}>{state}</Badge></button>;
        })}
        {!hardware.length && <EmptyState title="没有受管硬件" body="请先在设备管理中登记 MCP Server 及其硬件定义。" />}
      </div>
    </aside>
    <aside className="manual-tool-panel">
      <header><strong>硬件工具</strong><span>{tools.length}</span></header>
      {tools.map((tool) => <button key={tool.externalName} disabled={invoke.isPending} className={tool.externalName === toolName ? "active" : ""} onClick={() => setToolName(tool.externalName)}><strong>{tool.remoteName}</strong><small>{tool.description || tool.externalName}</small></button>)}
      {selectedHardware && availability !== "available" && <div className="manual-tool-empty"><IconAlert size={15} /><span>硬件当前为 {availability}，恢复在线后才能执行。</span></div>}
      {selectedHardware && availability === "available" && !tools.length && <div className="manual-tool-empty">该 Server 未暴露 hardware 工具。</div>}
    </aside>
    <section className="manual-call-panel">
      {selectedTool && displaySchema ? <>
        <header className="manual-call-head"><span><h2>{selectedTool.remoteName}</h2><small>{selectedTool.externalName}</small></span><Badge tone={availabilityTone(availability)}>{availability}</Badge></header>
        {selectedTool.description && <p className="muted-copy">{selectedTool.description}</p>}
        {runBusy && <div className="alert"><IconAlert size={15} /><span>自动测试 Run 正在执行，手动调用已禁用。</span></div>}
        <SchemaArgumentsForm schema={displaySchema} value={argumentsValue} onChange={setArgumentsValue} onValidityChange={setFormValid} />
        {validation.errors.length > 0 && <div className="validation-box invalid"><strong>参数校验</strong>{validation.errors.map((message, index) => <div key={index}><code>input</code><span>{message}</span></div>)}</div>}
        <div className="manual-call-actions"><Btn variant="primary" icon={<IconPlay size={13} />} disabled={!formValid || !validation.valid || availability !== "available" || runBusy || manualBusy || invoke.isPending} onClick={() => invoke.mutate()}>{invoke.isPending ? "正在执行…" : "执行一次"}</Btn><span>超时 30 秒 · Hardware ID 由 TestForge 自动注入</span></div>
        {(result || callError) && <section className={`manual-result${callError ? " failed" : ""}`}><header><strong>{callError ? "调用失败" : "调用成功"}</strong><span>{callError ? `${callError.durationMs} ms` : `${result!.durationMs} ms`}</span></header>{callError ? <div className="alert"><IconAlert size={15} /><span>{callError.message}</span></div> : <pre>{pretty(result!.output)}</pre>}</section>}
      </> : <EmptyState title={selectedHardware ? "选择一个硬件工具" : "选择受管硬件"} body="参数表单会根据 MCP 工具的 JSON Schema 自动生成。" />}
    </section>
  </main>;
}

function availabilityFor(hardwareId: string | undefined, availability: HardwareAvailability[]): HardwareAvailability["state"] {
  if (!hardwareId) return "unavailable";
  return availability.find((item) => item.hardwareId === hardwareId)?.state ?? "checking";
}
function availabilityTone(state: HardwareAvailability["state"]): BadgeTone { return state === "available" ? "ok" : state === "faulted" ? "bad" : state === "checking" ? "accent" : "muted"; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
