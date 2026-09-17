import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangleIcon, CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, CircleStopIcon,
  CopyIcon, GripVerticalIcon, PauseIcon, PlayIcon, PlusIcon, Redo2Icon, RefreshCwIcon, SaveIcon,
  Trash2Icon, Undo2Icon
} from "lucide-react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { TestPlan, TestPlanIssue, TestRunSnapshot, TestStep, TestStepCatalogItem } from "@hardwareharness/contracts/testing";
import { Button } from "../../shared/ui/button";
import { Badge } from "../../shared/ui/badge";
import { Checkbox } from "../../shared/ui/checkbox";
import { Field, Input, Select, Textarea } from "../../shared/ui/input";
import { cn } from "../../shared/ui/cn";
import { SchemaArgumentsForm } from "../manual/SchemaForm.js";
import type { JsonSchema } from "../manual/schema-form-model.js";
import { useKeyboardShortcut } from "../../shared/hooks/useKeyboardShortcut.js";
import { clonePlan, createStep, findStep, moveStep, planHardwareIds, removeStep, replaceHardware, type TestRegion } from "./plan-model.js";

const planKeys = { list: ["test-plans"] as const, plan: (id: string) => ["test-plan", id] as const, run: ["test-run"] as const };
const containerTypes = new Set(["Sequence", "Group", "If", "Repeat", "ForEach", "Parallel", "Retry"]);

export function TestPlanPage() {
  const client = useQueryClient();
  const plans = useQuery({ queryKey: planKeys.list, queryFn: () => window.hardwareharness.testing.listPlans() });
  const catalog = useQuery({ queryKey: ["test-step-catalog"], queryFn: () => window.hardwareharness.testing.listStepCatalog() });
  const hardware = useQuery({ queryKey: ["test-hardware"], queryFn: () => window.hardwareharness.devices.listHardware() });
  const currentRun = useQuery({ queryKey: planKeys.run, queryFn: () => window.hardwareharness.testing.currentRun(), refetchInterval: (query) => isActive(query.state.data) ? 500 : 3_000 });
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [draft, setDraft] = useState<TestPlan>();
  const [selectedStepId, setSelectedStepId] = useState<string>();
  const [past, setPast] = useState<TestPlan[]>([]);
  const [future, setFuture] = useState<TestPlan[]>([]);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [issues, setIssues] = useState<TestPlanIssue[]>([]);
  const [message, setMessage] = useState<string>();
  const [activeStep, setActiveStep] = useState<TestStep>();
  const [runParameters, setRunParameters] = useState("{}");

  useEffect(() => {
    if (!selectedPlanId && plans.data?.length) setSelectedPlanId(plans.data[0]!.id);
  }, [plans.data, selectedPlanId]);

  const loadPlan = useCallback(async (id: string, force = false) => {
    if (dirty && !force && !window.confirm("当前测试计划有未保存修改，确定放弃并切换吗？")) return;
    const plan = await window.hardwareharness.testing.loadPlan(id);
    setSelectedPlanId(id); setDraft(plan); setSelectedStepId(undefined); setPast([]); setFuture([]); setDirty(false); setConflict(false); setIssues([]); setMessage(undefined);
    client.setQueryData(planKeys.plan(id), plan);
  }, [client, dirty]);

  useEffect(() => { if (selectedPlanId && draft?.id !== selectedPlanId) void loadPlan(selectedPlanId, true); }, [selectedPlanId, draft?.id, loadPlan]);
  useEffect(() => window.hardwareharness.events.subscribe("testPlan", (payload) => {
    const event = payload as { planId?: string; revision?: number };
    void client.invalidateQueries({ queryKey: planKeys.list });
    if (event.planId !== selectedPlanId || event.revision === draft?.revision) return;
    if (dirty) setConflict(true); else if (selectedPlanId) void loadPlan(selectedPlanId, true);
  }), [client, selectedPlanId, draft?.revision, dirty, loadPlan]);
  useEffect(() => window.hardwareharness.events.subscribe("testRun", () => { void currentRun.refetch(); }), [currentRun]);
  useEffect(() => {
    const guard = (event: Event) => {
      if ((dirty || conflict) && !window.confirm("测试计划有未保存或冲突中的修改，确定离开吗？")) event.preventDefault();
    };
    window.addEventListener("hardwareharness:before-navigation", guard);
    return () => window.removeEventListener("hardwareharness:before-navigation", guard);
  }, [dirty, conflict]);

  const mutate = (change: (next: TestPlan) => void) => {
    if (!draft) return;
    const next = clonePlan(draft); change(next);
    setPast((items) => [...items.slice(-49), draft]); setFuture([]); setDraft(next); setDirty(true); setMessage(undefined);
  };
  const undo = () => { const previous = past.at(-1); if (!previous || !draft) return; setPast(past.slice(0, -1)); setFuture([draft, ...future]); setDraft(previous); setDirty(true); };
  const redo = () => { const next = future[0]; if (!next || !draft) return; setFuture(future.slice(1)); setPast([...past, draft]); setDraft(next); setDirty(true); };

  const save = async (): Promise<boolean> => {
    if (!draft || conflict) return false;
    try {
      const result = await window.hardwareharness.testing.savePlan(draft, draft.revision);
      setDraft(result.plan); setIssues(result.issues); setDirty(false); setConflict(false); setPast([]); setFuture([]); setMessage(`已保存 revision ${result.plan.revision}`);
      await client.invalidateQueries({ queryKey: planKeys.list });
      return true;
    } catch (error) {
      const candidate = error as { category?: string; details?: { currentRevision?: number }; message?: string };
      if (candidate.category === "conflict") setConflict(true);
      setMessage(candidate.message ?? String(error));
      return false;
    }
  };
  useKeyboardShortcut("s", save, Boolean(draft));

  const validate = async () => {
    if (!draft || dirty) { setMessage("请先保存当前草稿再校验。"); return; }
    const result = await window.hardwareharness.testing.validatePlan(draft.id); setIssues(result.issues); setMessage(result.valid ? `revision ${result.revision} 校验通过` : "计划存在阻止运行的问题");
  };
  const start = async () => {
    if (!draft) return;
    if (conflict) { setMessage("请先解决计划冲突再启动运行。"); return; }
    if (dirty && !await save()) return;
    const latest = dirty ? await window.hardwareharness.testing.loadPlan(draft.id) : draft;
    const validation = await window.hardwareharness.testing.validatePlan(latest.id); setIssues(validation.issues);
    if (!validation.valid) { setMessage("校验未通过，未启动运行。"); return; }
    let parameters: Record<string, unknown>;
    try { parameters = JSON.parse(runParameters) as Record<string, unknown>; } catch { setMessage("运行参数必须是 JSON object。"); return; }
    await window.hardwareharness.testing.startRun({ planId: latest.id, revision: validation.revision, requestId: crypto.randomUUID(), parameters });
    await currentRun.refetch(); setMessage("测试运行已启动");
  };
  const create = async () => {
    const result = await window.hardwareharness.testing.createPlan({ requestId: crypto.randomUUID(), name: `新测试计划 ${new Date().toLocaleTimeString()}` });
    await client.invalidateQueries({ queryKey: planKeys.list }); setSelectedPlanId(result.plan.id); setDraft(result.plan); setDirty(false);
  };
  const saveAs = async () => {
    if (!draft) return;
    const created = await window.hardwareharness.testing.createPlan({ requestId: crypto.randomUUID(), name: `${draft.name} - 本地副本`, description: draft.description, parameters: draft.parameters });
    const copy = { ...clonePlan(draft), id: created.plan.id, name: created.plan.name, revision: created.plan.revision, createdAt: created.plan.createdAt, updatedAt: created.plan.updatedAt };
    const saved = await window.hardwareharness.testing.savePlan(copy, copy.revision);
    await client.invalidateQueries({ queryKey: planKeys.list }); setSelectedPlanId(saved.plan.id); setDraft(saved.plan); setDirty(false); setConflict(false);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragStart = (event: DragStartEvent) => setActiveStep(draft ? findStep(draft, String(event.active.id))?.step : undefined);
  const onDragEnd = (event: DragEndEvent) => {
    setActiveStep(undefined); if (!draft || !event.over || event.active.id === event.over.id) return;
    const overId = String(event.over.id);
    mutate((next) => {
      if (overId.startsWith("region:")) { moveStep(next, String(event.active.id), { region: overId.slice(7) as TestRegion }); return; }
      const target = findStep(next, overId);
      if (!target) return;
      if (containerTypes.has(target.step.type)) moveStep(next, String(event.active.id), { region: target.region, parentId: target.step.id });
      else moveStep(next, String(event.active.id), { region: target.region, ...(target.parentId ? { parentId: target.parentId } : {}), branch: target.branch, index: target.index });
    });
  };

  const selectedStep = draft && selectedStepId ? findStep(draft, selectedStepId)?.step : undefined;
  const run = currentRun.data;
  return <div className="grid h-full min-h-0 grid-cols-[250px_minmax(420px,1fr)_320px] grid-rows-[minmax(0,1fr)_190px] overflow-hidden">
    <aside className="row-span-2 flex min-h-0 flex-col border-r bg-secondary/15">
      <PaneHeader title="测试计划" action={<Button size="icon-xs" variant="ghost" aria-label="新建测试计划" onClick={() => void create()}><PlusIcon /></Button>} />
      <div className="max-h-[32%] overflow-auto p-2">
        {(plans.data ?? []).map((plan) => <button key={plan.id} className={cn("mb-1 grid w-full gap-0.5 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent", plan.id === selectedPlanId && "bg-accent text-accent-foreground")} onClick={() => void loadPlan(plan.id)}>
          <span className="truncate font-medium">{plan.name}</span><span className="flex items-center justify-between text-[10px] text-muted-foreground"><span>rev {plan.revision}</span><span>{plan.stepCount ?? 0} 步</span></span>
        </button>)}
      </div>
      <PaneHeader title="步骤库" />
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {groupCatalog(catalog.data ?? []).map(([category, entries]) => <section key={category} className="mb-3"><h3 className="mb-1 px-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{category}</h3>
          <div className="grid grid-cols-2 gap-1">{entries.map((item) => <button key={item.type} className="rounded-md border bg-background px-2 py-1.5 text-left text-[11px] hover:border-primary/40 hover:bg-accent" onClick={() => draft && mutate((next) => next.regions.test.push(createStep(item)))}>{item.label}</button>)}</div>
        </section>)}
      </div>
      <PaneHeader title="具体设备" />
      <div className="max-h-[22%] overflow-auto p-2 text-xs">{(hardware.data ?? []).map((item) => <div key={item.hardwareId} className="flex items-center justify-between rounded px-2 py-1.5"><span className="truncate">{item.label}</span><code className="ml-2 text-[9px] text-muted-foreground">{item.hardwareId}</code></div>)}</div>
    </aside>

    <main className="min-h-0 overflow-auto bg-background p-3">
      {conflict && <ConflictBanner onReload={() => selectedPlanId && void loadPlan(selectedPlanId, true)} onSaveAs={() => void saveAs()} />}
      {draft ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveStep(undefined)}>
        <div className="mx-auto grid max-w-4xl gap-3">
          {(["prepare", "test", "cleanup"] as TestRegion[]).map((region) => <RegionTree key={region} region={region} steps={draft.regions[region]} selectedId={selectedStepId} onSelect={setSelectedStepId} onToggle={(id) => mutate((next) => { const step = findStep(next, id)?.step; if (step) step.enabled = !step.enabled; })} onDuplicate={(id) => mutate((next) => { const found = findStep(next, id); if (found) { const copy = structuredClone(found.step); regenerateIds(copy); copy.name = `${copy.name ?? copy.type} 副本`; found.list.splice(found.index + 1, 0, copy); } })} onDelete={(id) => mutate((next) => removeStep(next, id))} />)}
        </div><DragOverlay>{activeStep && <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-xl">{activeStep.name ?? activeStep.type}</div>}</DragOverlay>
      </DndContext> : <div className="grid h-full place-items-center text-sm text-muted-foreground">新建或选择一个测试计划</div>}
    </main>

    <aside className="min-h-0 overflow-auto border-l bg-secondary/10">
      <PaneHeader title="属性" />
      {draft ? <Inspector plan={draft} step={selectedStep} hardware={hardware.data ?? []} mutate={mutate} /> : null}
    </aside>

    <section className="col-span-2 col-start-2 grid min-h-0 grid-cols-[auto_1fr] border-t bg-secondary/10">
      <div className="flex w-52 flex-col gap-2 border-r p-3">
        <div className="flex flex-wrap gap-1.5"><Button size="sm" onClick={() => void save()} disabled={!dirty || conflict}><SaveIcon />保存</Button><Button size="sm" variant="outline" onClick={() => void validate()}><CheckCircle2Icon />校验</Button></div>
        <div className="flex gap-1"><Button size="icon-sm" variant="ghost" onClick={undo} disabled={!past.length}><Undo2Icon /></Button><Button size="icon-sm" variant="ghost" onClick={redo} disabled={!future.length}><Redo2Icon /></Button></div>
        <Textarea aria-label="运行参数 JSON" className="min-h-14 resize-none font-mono text-[10px]" value={runParameters} onChange={(event) => setRunParameters(event.target.value)} />
        <RunControls run={run} onStart={() => void start()} onChanged={() => void currentRun.refetch()} />
      </div>
      <div className="min-w-0 overflow-auto p-3 text-xs">
        <div className="mb-2 flex items-center gap-2"><strong>状态</strong>{dirty && <Badge variant="warning">未保存</Badge>}{run && <Badge variant={run.verdict === "Pass" ? "success" : run.verdict === "Fail" || run.verdict === "Error" ? "destructive" : "secondary"}>{run.state} · {run.verdict}</Badge>}{message && <span className="text-muted-foreground">{message}</span>}</div>
        {issues.length ? <div className="grid gap-1">{issues.map((item, index) => <div key={`${item.path}-${index}`} className={cn("flex gap-2 rounded px-2 py-1.5", item.severity === "error" ? "bg-destructive/8 text-destructive" : "bg-warning/10 text-warning")}><AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0"/><span><b>{item.code}</b> {item.message}<code className="ml-2 opacity-70">{item.path}</code></span></div>)}</div> : <p className="text-muted-foreground">保存并校验后，这里显示校验问题；运行事件与 Verdict 会实时恢复。</p>}
      </div>
    </section>
  </div>;
}

function RegionTree({ region, steps, selectedId, onSelect, onToggle, onDuplicate, onDelete }: { region: TestRegion; steps: TestStep[]; selectedId: string | undefined; onSelect: (id: string) => void; onToggle: (id: string) => void; onDuplicate: (id: string) => void; onDelete: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `region:${region}`, data: { region } });
  const labels = { prepare: "准备", test: "测试", cleanup: "清理" };
  return <section ref={setNodeRef} className={cn("rounded-xl border bg-secondary/10 p-2 shadow-sm", isOver && "ring-2 ring-primary/30")}><header className="mb-2 flex items-center justify-between px-1"><h2 className="text-xs font-semibold">{labels[region]}</h2><Badge variant="outline">{steps.length}</Badge></header>
    <SortableContext items={steps.map((step) => step.id)} strategy={verticalListSortingStrategy}><div className="grid min-h-10 gap-1.5">{steps.map((step) => <SortableStep key={step.id} step={step} region={region} selectedId={selectedId} onSelect={onSelect} onToggle={onToggle} onDuplicate={onDuplicate} onDelete={onDelete} />)}{!steps.length && <div className="grid min-h-12 place-items-center rounded-lg border border-dashed text-[11px] text-muted-foreground">拖入步骤或从左侧添加</div>}</div></SortableContext>
  </section>;
}

function SortableStep({ step, region, selectedId, onSelect, onToggle, onDuplicate, onDelete, depth = 0, parentId }: { step: TestStep; region: TestRegion; selectedId: string | undefined; onSelect: (id: string) => void; onToggle: (id: string) => void; onDuplicate: (id: string) => void; onDelete: (id: string) => void; depth?: number; parentId?: string }) {
  const [open, setOpen] = useState(true);
  const sortable = useSortable({ id: step.id, data: { region, parentId } });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const nested = [...(step.children ?? []), ...(step.elseChildren ?? [])];
  return <div ref={sortable.setNodeRef} style={style} className={cn("rounded-lg border bg-background shadow-xs", sortable.isDragging && "opacity-35", selectedId === step.id && "border-primary/50 ring-2 ring-primary/15", step.enabled === false && "opacity-55")}>
    <div className="flex h-9 items-center gap-1 px-1.5" onClick={() => onSelect(step.id)}>
      <button className="cursor-grab touch-none text-muted-foreground" {...sortable.attributes} {...sortable.listeners} aria-label={`拖动 ${step.name ?? step.type}`}><GripVerticalIcon className="size-4" /></button>
      {containerTypes.has(step.type) ? <button onClick={(event) => { event.stopPropagation(); setOpen(!open); }}>{open ? <ChevronDownIcon className="size-3.5"/> : <ChevronRightIcon className="size-3.5"/>}</button> : <span className="w-3.5" />}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{step.name ?? step.type}</span><code className="text-[9px] text-muted-foreground">{step.type}</code>
      <Checkbox checked={step.enabled !== false} onCheckedChange={() => onToggle(step.id)} onClick={(event) => event.stopPropagation()} />
      <Button size="icon-xs" variant="ghost" aria-label="复制步骤" onClick={(event) => { event.stopPropagation(); onDuplicate(step.id); }}><CopyIcon /></Button>
      <Button size="icon-xs" variant="ghost" aria-label="删除步骤" onClick={(event) => { event.stopPropagation(); onDelete(step.id); }}><Trash2Icon /></Button>
    </div>
    {open && nested.length > 0 && <div className="ml-5 grid gap-1.5 border-l px-2 pb-2"><SortableContext items={nested.map((item) => item.id)} strategy={verticalListSortingStrategy}>{(step.children ?? []).map((child) => <SortableStep key={child.id} step={child} region={region} parentId={step.id} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} onToggle={onToggle} onDuplicate={onDuplicate} onDelete={onDelete} />)}{(step.elseChildren ?? []).length > 0 && <div className="pt-1 text-[9px] font-semibold text-muted-foreground">ELSE</div>}{(step.elseChildren ?? []).map((child) => <SortableStep key={child.id} step={child} region={region} parentId={step.id} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} onToggle={onToggle} onDuplicate={onDuplicate} onDelete={onDelete} />)}</SortableContext></div>}
  </div>;
}

function Inspector({ plan, step, hardware, mutate }: { plan: TestPlan; step: TestStep | undefined; hardware: Hardware[]; mutate: (change: (next: TestPlan) => void) => void }) {
  if (!step) return <PlanInspector plan={plan} hardware={hardware} mutate={mutate} />;
  const update = (patch: Record<string, unknown>) => mutate((next) => { const target = findStep(next, step.id)?.step; if (target) for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete target[key]; else target[key] = value; } });
  return <div className="grid gap-3 p-3"><Field label="步骤名称"><Input value={step.name ?? ""} onChange={(event) => update({ name: event.target.value })}/></Field><Field label="稳定步骤 ID"><Input value={step.id} readOnly /></Field><div className="flex gap-2"><Badge variant="secondary">{step.type}</Badge>{step.hardwareId && <Badge variant="outline">{step.hardwareId}</Badge>}</div>
    {step.type === "InvokeTool" ? <InvokeInspector step={step} hardware={hardware} update={update} /> : <GenericSettings step={step} update={update} />}
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={step.stopOnFail === true} onCheckedChange={(checked) => update({ stopOnFail: checked === true })}/>此步骤 Fail 后停止所在组</label>
  </div>;
}

function PlanInspector({ plan, hardware, mutate }: { plan: TestPlan; hardware: Hardware[]; mutate: (change: (next: TestPlan) => void) => void }) {
  const [parameters, setParameters] = useState(() => JSON.stringify(plan.parameters, null, 2));
  const [sourceHardwareId, setSourceHardwareId] = useState("");
  const [targetHardwareId, setTargetHardwareId] = useState("");
  const boundHardwareIds = planHardwareIds(plan);
  useEffect(() => setParameters(JSON.stringify(plan.parameters, null, 2)), [plan.id, plan.revision, plan.parameters]);
  return <div className="grid gap-3 p-3"><Field label="计划名称"><Input value={plan.name} onChange={(event) => mutate((next) => { next.name = event.target.value; })} /></Field><Field label="说明"><Textarea value={plan.description} onChange={(event) => mutate((next) => { next.description = event.target.value; })} /></Field><Field label="有类型运行参数 JSON" hint='例如 [{"name":"voltage","type":"number","required":true}]'><Textarea className="min-h-36 font-mono text-[11px]" value={parameters} onChange={(event) => { setParameters(event.target.value); try { const parsed = JSON.parse(event.target.value) as TestPlan["parameters"]; if (Array.isArray(parsed)) mutate((next) => { next.parameters = parsed; }); } catch { /* preserve draft text */ } }}/></Field><label className="flex items-center gap-2 text-xs"><Checkbox checked={plan.stopOnFail} onCheckedChange={(checked) => mutate((next) => { next.stopOnFail = checked === true; })}/>Fail 时停止计划</label>
    <div className="grid gap-2 rounded-lg border p-2"><div className="text-[11px] font-semibold">批量替换具体设备</div><Select aria-label="待替换设备" value={sourceHardwareId} onChange={(event) => setSourceHardwareId(event.target.value)}><option value="">选择计划内设备</option>{boundHardwareIds.map((hardwareId) => <option key={hardwareId} value={hardwareId}>{hardwareId}</option>)}</Select><Select aria-label="替换为设备" value={targetHardwareId} onChange={(event) => setTargetHardwareId(event.target.value)}><option value="">选择 managed hardware</option>{hardware.filter((item) => item.kind === "managed" && item.hardwareId !== sourceHardwareId).map((item) => <option key={item.hardwareId} value={item.hardwareId}>{item.label} · {item.hardwareId}</option>)}</Select><Button size="sm" variant="outline" disabled={!sourceHardwareId || !targetHardwareId} onClick={() => { mutate((next) => replaceHardware(next, sourceHardwareId, targetHardwareId)); setSourceHardwareId(""); setTargetHardwareId(""); }}>替换并重新校验绑定</Button></div>
    <div className="rounded-md bg-secondary p-2 text-[11px] text-muted-foreground">计划直接绑定具体设备；运行使用保存 revision 的不可变快照。</div></div>;
}

function InvokeInspector({ step, hardware, update }: { step: TestStep; hardware: Hardware[]; update: (patch: Record<string, unknown>) => void }) {
  const tools = useQuery({ queryKey: ["test-device-tools", step.hardwareId], queryFn: () => window.hardwareharness.testing.listDeviceTools(step.hardwareId!), enabled: Boolean(step.hardwareId) });
  const selected = tools.data?.tools.find((tool) => tool.toolName === step.toolName);
  return <><Field label="具体设备" required><Select value={step.hardwareId ?? ""} onChange={(event) => update({ hardwareId: event.target.value || undefined, toolName: undefined, toolContractRevision: undefined, inputSchemaHash: undefined, arguments: {} })}><option value="">选择 managed hardware</option>{hardware.filter((item) => item.kind === "managed").map((item) => <option key={item.hardwareId} value={item.hardwareId}>{item.label} · {item.hardwareId}</option>)}</Select></Field>
    <Field label="原始工具名" required><Select value={step.toolName ?? ""} disabled={!step.hardwareId} onChange={(event) => { const tool = tools.data?.tools.find((item) => item.toolName === event.target.value); update(tool ? { toolName: tool.toolName, toolContractRevision: tool.toolContractRevision, inputSchemaHash: tool.inputSchemaHash, arguments: {} } : { toolName: undefined }); }}><option value="">选择设备工具</option>{(tools.data?.tools ?? []).map((tool) => <option key={tool.toolName} value={tool.toolName}>{tool.toolName}</option>)}</Select></Field>
    <Field label="超时 (ms)"><Input type="number" min={1} value={Number(step.timeoutMs ?? 30_000)} onChange={(event) => update({ timeoutMs: Number(event.target.value) })}/></Field>
    <Field label="错误策略"><Select value={String(step.errorPolicy ?? "error")} onChange={(event) => update({ errorPolicy: event.target.value })}><option value="error">记录 Error 并进入清理</option><option value="fail">已知结果错误转为 Fail 并继续</option></Select></Field>
    {selected && <div className="rounded-lg border p-2"><div className="mb-2 text-[11px] font-semibold">参数绑定</div><SchemaArgumentsForm schema={selected.inputSchema as JsonSchema} value={step.arguments ?? {}} onChange={(argumentsValue) => update({ arguments: argumentsValue })}/></div>}
    {step.inputSchemaHash && <code className="break-all text-[9px] text-muted-foreground">schema {step.inputSchemaHash}</code>}</>;
}

function GenericSettings({ step, update }: { step: TestStep; update: (patch: Record<string, unknown>) => void }) {
  const protectedKeys = new Set(["id", "type", "name", "enabled", "children", "elseChildren", "stopOnFail"]);
  const settings = Object.fromEntries(Object.entries(step).filter(([key]) => !protectedKeys.has(key)));
  const [text, setText] = useState(() => JSON.stringify(settings, null, 2));
  useEffect(() => setText(JSON.stringify(Object.fromEntries(Object.entries(step).filter(([key]) => !protectedKeys.has(key))), null, 2)), [step.id, step.type]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Field label="步骤设置 JSON" hint="表达式使用受限 CEL；不得写入 Python。"><Textarea className="min-h-44 font-mono text-[11px]" value={text} onChange={(event) => { setText(event.target.value); try { const parsed = JSON.parse(event.target.value) as Record<string, unknown>; update(parsed); } catch { /* retain invalid local text until corrected */ } }}/></Field>;
}

function RunControls({ run, onStart, onChanged }: { run: TestRunSnapshot | null | undefined; onStart: () => void; onChanged: () => void }) {
  if (!isActive(run)) return <Button size="sm" onClick={onStart}><PlayIcon />运行</Button>;
  return <div className="flex gap-1"><Button size="icon-sm" variant="outline" aria-label={run.state === "paused" ? "继续" : "暂停"} onClick={async () => { if (run.state === "paused") await window.hardwareharness.testing.resumeRun(run.runId); else await window.hardwareharness.testing.pauseRun(run.runId); onChanged(); }}>{run.state === "paused" ? <PlayIcon /> : <PauseIcon />}</Button><Button size="icon-sm" variant="destructive" aria-label="终止" onClick={async () => { await window.hardwareharness.testing.abortRun(run.runId); onChanged(); }}><CircleStopIcon /></Button></div>;
}

function ConflictBanner({ onReload, onSaveAs }: { onReload: () => void; onSaveAs: () => void }) { return <div className="mb-3 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning"><AlertTriangleIcon className="size-4"/><span className="flex-1">AI 或磁盘已修改当前计划。为保护本地草稿，直接保存已禁用。</span><Button size="xs" variant="outline" onClick={onReload}><RefreshCwIcon/>重载 AI 版本</Button><Button size="xs" variant="outline" onClick={onSaveAs}>另存本地草稿</Button></div>; }
function PaneHeader({ title, action }: { title: string; action?: React.ReactNode }) { return <div className="flex h-9 shrink-0 items-center justify-between border-b px-3"><h2 className="text-[11px] font-semibold tracking-wide">{title}</h2>{action}</div>; }
function groupCatalog(items: TestStepCatalogItem[]): Array<[string, TestStepCatalogItem[]]> { const groups = new Map<string, TestStepCatalogItem[]>(); for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]); return [...groups]; }
function isActive(run: TestRunSnapshot | null | undefined): run is TestRunSnapshot { return Boolean(run && !["completed", "aborted", "error"].includes(run.state)); }
function regenerateIds(step: TestStep): void { step.id = `${step.type.toLowerCase()}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`; for (const child of [...(step.children ?? []), ...(step.elseChildren ?? [])]) regenerateIds(child); }
