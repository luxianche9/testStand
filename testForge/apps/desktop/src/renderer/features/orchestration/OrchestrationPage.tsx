import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon, PlayIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { activeExecutionActivities, executionHardwareIds } from "@testforge/contracts/execution";
import type { TaskValidationResult, TestStep, TestTask } from "@testforge/contracts/orchestration";
import type { ProjectDocument } from "@testforge/contracts/projects";
import { errorMessage } from "../../shared/errors.js";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../shared/ui/dialog";
import { Centered } from "../../shared/ui/empty-state";
import { Spinner } from "../../shared/ui/skeleton";
import { useDashboard, useProjectDocument } from "../../shared/queries.js";
import { queryKeys } from "../../shared/query-keys.js";
import { useResizableWidth } from "../../shared/resizable.js";
import { RunDetail } from "../run-logs/index.js";
import { StepPalette, StepOutline } from "./StepOutline.js";
import { StepProperties, VariableEditor } from "./StepEditor.js";
import { ValidationPanel } from "./ValidationPanel.js";
import { OperatorDecisionModal, RunInputsModal } from "./RunPanel.js";
import { duplicateTaskStep, findStep, moveTaskStep, newStep, removeTaskStep, replaceTaskStep, stepTypeLabel, taskHardwareIds } from "./workflow-model.js";
import { acceptAppliedTask, createTaskDraftState, receiveExternalTask, resolveExternalTask, updateTaskDraft } from "./task-draft-state.js";

const SECTIONS = ["setup", "steps", "cleanup"] as const;
type SectionName = (typeof SECTIONS)[number];
const SECTION_LABELS: Record<SectionName, string> = { setup: "Setup", steps: "Steps", cleanup: "Cleanup" };

export function OrchestrationPage() {
  const client = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const project = useProjectDocument();
  const decisions = useQuery({ queryKey: queryKeys.operatorDecisions, queryFn: () => window.testforge.orchestration.listOperatorDecisions() });

  useEffect(() => {
    const refreshDecisions = () => void client.invalidateQueries({ queryKey: queryKeys.operatorDecisions });
    const stopOperator = window.testforge.events.subscribe("operator", refreshDecisions);
    const stopRun = window.testforge.events.subscribe("run", (payload) => {
      const run = payload as { runId?: string };
      if (run.runId) setSelectedRunId(run.runId);
    });
    const fallback = window.setInterval(() => { refreshDecisions(); }, 15_000);
    return () => { stopOperator(); stopRun(); window.clearInterval(fallback); };
  }, [client]);

  useEffect(() => { setSelectedRunId(undefined); }, [project.data?.path, project.data?.file.task.taskId]);

  if (project.isLoading) return <Centered><Spinner label="正在加载测试编排…" /></Centered>;
  if (project.isError || !project.data) return <Centered><div className="flex items-center gap-2 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive"><TriangleAlertIcon className="size-4 shrink-0" /><span>{errorMessage(project.error ?? "未打开工程")}</span></div></Centered>;

  return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)]">
      <TaskWorkspace
        key={`${project.data.file.projectId}:${project.data.path ?? "untitled"}`}
        project={project.data}
        selectedRunId={selectedRunId}
        onRunSelected={setSelectedRunId}
      />
    </div>
    <OperatorDecisionModal decision={decisions.data?.[0]} onResponded={() => void client.invalidateQueries({ queryKey: queryKeys.operatorDecisions })} />
  </main>;
}

function TaskWorkspace({ project, selectedRunId, onRunSelected }: {
  project: ProjectDocument;
  selectedRunId?: string | undefined;
  onRunSelected: (runId: string | undefined) => void;
}) {
  const client = useQueryClient();
  const tools = useDashboard();

  const projectIdentity = `${project.file.projectId}:${project.path ?? "untitled"}`;
  const [draftState, setDraftState] = useState(() => createTaskDraftState(projectIdentity, project.file.task));
  const [selectedStepId, setSelectedStepId] = useState<string>();
  const [editingStepId, setEditingStepId] = useState<string>();
  const [section, setSection] = useState<SectionName>("steps");
  const [validation, setValidation] = useState<TaskValidationResult>();
  const [runInputsOpen, setRunInputsOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const inspector = useResizableWidth({ defaultWidth: 340, min: 260, max: 640, direction: "left" });

  // External file changes are adopted automatically only while the local draft is clean.
  useEffect(() => {
    setDraftState((current) => receiveExternalTask(current, projectIdentity, project.file.task));
    setValidation(undefined);
    setNotice(undefined);
  }, [project.file.task, projectIdentity]);

  const task = draftState.draft;
  const requiredHardwareIds = new Set(taskHardwareIds(task));
  const manualBusyHardwareIds = [...new Set(activeExecutionActivities(tools.data?.execution)
    .filter((activity) => activity.state === "manual")
    .flatMap(executionHardwareIds)
    .filter((hardwareId) => requiredHardwareIds.has(hardwareId)))];
  const manualBusy = manualBusyHardwareIds.length > 0;

  const apply = useMutation({
    mutationFn: async (next: TestTask) => await window.testforge.orchestration.updateTask(next),
    onSuccess: async (doc) => {
      client.setQueryData(queryKeys.projectDocument, doc);
      setDraftState((current) => acceptAppliedTask(current, doc.file.task));
      setNotice("已应用到工程（尚未写盘，请用文件菜单保存）");
    }
  });
  const validate = useMutation({
    mutationFn: (next: TestTask) => window.testforge.orchestration.validateTask(next),
    onSuccess: (result) => { setValidation(result); setNotice(result.valid ? "校验通过" : undefined); }
  });
  const start = useMutation({
    mutationFn: async (inputs: Record<string, unknown>) => {
      // Push the draft into the buffer first so the run sees the latest steps.
      await window.testforge.orchestration.updateTask(task);
      return await window.testforge.orchestration.startRun({ inputs });
    },
    onSuccess: async (detail) => {
      setRunInputsOpen(false);
      onRunSelected(detail.run.runId);
      setNotice(`Run ${detail.run.status}`);
      await client.invalidateQueries({ queryKey: queryKeys.projectDocument });
    }
  });

  const update = useCallback((next: TestTask) => { setDraftState((current) => updateTaskDraft(current, next)); setNotice(undefined); }, []);
  const addStep = (type: TestStep["type"]) => {
    if (!task) return;
    const step = newStep(type);
    update({ ...task, [section]: [...task[section], step] });
    setSelectedStepId(step.stepId);
    setEditingStepId(step.stepId);
  };

  const selected = findStep(task, selectedStepId);
  const editing = findStep(task, editingStepId);
  const error = apply.error ?? validate.error ?? start.error;

  return <section className="relative flex min-h-0 min-w-0 flex-col">
    <div className="flex items-center justify-end gap-2 border-b bg-card px-3 py-2">
      <Button variant="ghost" size="sm" onClick={() => { void client.invalidateQueries({ queryKey: queryKeys.projectDocument }); }}><RefreshCwIcon className="size-3.5" />刷新</Button>
      <Button variant="ghost" size="sm" disabled={apply.isPending} onClick={() => apply.mutate(task)}>应用</Button>
      <Button variant="ghost" size="sm" disabled={validate.isPending} onClick={() => validate.mutate(task)}>校验</Button>
      <Button
        size="sm"
        disabled={start.isPending || manualBusy}
        title={manualBusy ? `手动调用正在使用：${manualBusyHardwareIds.join(", ")}` : undefined}
        onClick={() => { if (task.inputs.length > 0) setRunInputsOpen(true); else start.mutate({}); }}
      ><PlayIcon className="size-3.5" />运行</Button>
    </div>

    {(error || notice || manualBusy) && <div className={`mx-4 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${error ? "border-destructive/60 bg-destructive/10 text-destructive" : "border-success/40 bg-success/10 text-success"}`}>
      {error && <TriangleAlertIcon className="size-4 shrink-0" />}
      <span>{error ? errorMessage(error) : manualBusy ? `手动调用正在使用 Run 所需硬件（${manualBusyHardwareIds.join(", ")}），完成后才能启动。` : notice}</span>
    </div>}

    <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `150px minmax(0, 1fr)${editing ? ` 5px ${inspector.width}px` : ""}` }}>
      <StepPalette onAdd={addStep} />
      <div className="flex min-w-0 flex-col gap-3 overflow-auto p-3.5">
        <VariableEditor task={task} onChange={update} />
        {SECTIONS.map((name) => <section
          className={`rounded-md border p-2.5 ${section === name ? "border-ring" : ""}`}
          key={name}
          onClick={() => setSection(name)}
        >
          <h3 className="mb-2 flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{SECTION_LABELS[name]} <Badge variant="secondary">{task[name].length}</Badge></h3>
          <StepOutline
            steps={task[name]}
            selected={selectedStepId}
            onSelect={setSelectedStepId}
            onEdit={setEditingStepId}
            onMove={(sourceId, targetId) => update(moveTaskStep(task, sourceId, targetId))}
          />
          {task[name].length === 0 && <div className="p-4 text-center text-xs text-muted-foreground/60">从左侧添加步骤</div>}
        </section>)}
        {validation && <ValidationPanel validation={validation} onSelect={setSelectedStepId} />}
      </div>
      {editing && <>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整步骤属性面板宽度"
          title="拖拽调整宽度"
          className="cursor-col-resize bg-transparent transition-colors hover:bg-ring/30"
          {...inspector.handleProps}
        />
        <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l bg-secondary/50" aria-label="步骤属性">
          <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5 text-xs">
            <strong className="truncate text-sm font-semibold">步骤属性 · {stepTypeLabel(editing.type)}</strong>
            <Button variant="ghost" size="icon-xs" aria-label="关闭步骤属性" onClick={() => setEditingStepId(undefined)}><XIcon className="size-3.5" /></Button>
          </header>
          <div className="min-h-0 overflow-y-auto p-3.5">
            <StepProperties
              step={editing}
              task={task}
              tools={tools.data?.tools ?? []}
              onChange={(step) => update(replaceTaskStep(task, step))}
              onDelete={() => { update(removeTaskStep(task, editing.stepId)); setEditingStepId(undefined); }}
              onDuplicate={() => { const result = duplicateTaskStep(task, editing.stepId); update(result.task); setEditingStepId(result.newStepId); }}
            />
          </div>
        </aside>
      </>}
    </div>

    <Dialog open={Boolean(selectedRunId)} onOpenChange={(open) => { if (!open) onRunSelected(undefined); }}>
      <DialogContent size="xl" className="w-[760px]">
        <DialogHeader title="运行结果" onClose={() => onRunSelected(undefined)} />
        <DialogBody>
          {selectedRunId && <RunDetail key={selectedRunId} runId={selectedRunId} />}
        </DialogBody>
      </DialogContent>
    </Dialog>

    <RunInputsModal
      open={runInputsOpen}
      inputs={task.inputs}
      pending={start.isPending || manualBusy}
      onClose={() => setRunInputsOpen(false)}
      onRun={(values) => start.mutate(values)}
    />

    <Dialog open={Boolean(draftState.pendingExternal)} onOpenChange={() => undefined}>
      <DialogContent>
        <DialogHeader title="工程中的编排已在外部更新" />
        <DialogBody>
          <p className="m-0 text-sm">检测到工程文件中的任务已变化，同时当前页面还有未应用的编辑。请选择要继续使用的版本；此操作不会写入磁盘。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDraftState((current) => resolveExternalTask(current, "adopt-external"))}>采用外部版本</Button>
          <Button onClick={() => setDraftState((current) => resolveExternalTask(current, "keep-local"))}>保留我的编辑</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
