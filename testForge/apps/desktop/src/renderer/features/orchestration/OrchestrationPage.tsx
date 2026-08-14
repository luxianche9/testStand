import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskValidationResult, TestStep, TestTask } from "@testforge/contracts/orchestration";
import type { ProjectDocument } from "@testforge/contracts/projects";
import { IconAlert, IconPlay, IconRefresh } from "../../shared/icons.js";
import { Badge, Btn, Modal, Spinner } from "../../shared/ui.js";
import { useDashboard, useProjectDocument } from "../../shared/queries.js";
import { useResizableWidth } from "../../shared/resizable.js";
import { StepPalette, StepOutline } from "./StepOutline.js";
import { StepProperties, VariableEditor } from "./StepEditor.js";
import { ValidationPanel } from "./ValidationPanel.js";
import { OperatorDecisionModal, RunInputsModal, RunInspector } from "./RunPanel.js";
import { duplicateTaskStep, findStep, moveTaskStep, newStep, removeTaskStep, replaceTaskStep, stepTypeLabel } from "./workflow-model.js";

const SECTIONS = ["setup", "steps", "cleanup"] as const;
type SectionName = (typeof SECTIONS)[number];
const SECTION_LABELS: Record<SectionName, string> = { setup: "Setup", steps: "Steps", cleanup: "Cleanup" };

export function OrchestrationPage() {
  const client = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const project = useProjectDocument();
  const decisions = useQuery({ queryKey: ["operator-decisions"], queryFn: () => window.testforge.orchestration.listOperatorDecisions() });

  useEffect(() => {
    const refreshDecisions = () => void client.invalidateQueries({ queryKey: ["operator-decisions"] });
    const stopOperator = window.testforge.events.subscribe("operator", refreshDecisions);
    const stopProject = window.testforge.events.subscribe("project", (payload) => {
      client.setQueryData(["project-document"], payload);
      setSelectedRunId(undefined);
    });
    const stopRun = window.testforge.events.subscribe("run", (payload) => {
      const run = payload as { runId?: string };
      if (run.runId) setSelectedRunId(run.runId);
    });
    const fallback = window.setInterval(() => { refreshDecisions(); }, 15_000);
    return () => { stopOperator(); stopProject(); stopRun(); window.clearInterval(fallback); };
  }, [client]);

  if (project.isLoading) return <div className="centered"><Spinner label="正在加载测试编排…" /></div>;
  if (project.isError || !project.data) return <div className="centered alert"><IconAlert size={15} /><span>{String(project.error ?? "未打开工程")}</span></div>;

  return <main className="orchestration-page">
    <div className="orchestration-shell single-task">
      <TaskWorkspace
        key={project.data.file.task.taskId + (project.data.path ?? "untitled")}
        project={project.data}
        selectedRunId={selectedRunId}
        onRunSelected={setSelectedRunId}
      />
    </div>
    <OperatorDecisionModal decision={decisions.data?.[0]} onResponded={() => void client.invalidateQueries({ queryKey: ["operator-decisions"] })} />
  </main>;
}

function TaskWorkspace({ project, selectedRunId, onRunSelected }: {
  project: ProjectDocument;
  selectedRunId?: string | undefined;
  onRunSelected: (runId: string | undefined) => void;
}) {
  const client = useQueryClient();
  const tools = useDashboard();

  const [draft, setDraft] = useState<TestTask>(() => structuredClone(project.file.task));
  const [selectedStepId, setSelectedStepId] = useState<string>();
  const [editingStepId, setEditingStepId] = useState<string>();
  const [section, setSection] = useState<SectionName>("steps");
  const [validation, setValidation] = useState<TaskValidationResult>();
  const [runInputsOpen, setRunInputsOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const inspector = useResizableWidth({ defaultWidth: 340, min: 260, max: 640, direction: "left" });

  // When the open project file changes (new/open), reset the local draft to the buffer's task.
  useEffect(() => {
    setDraft(structuredClone(project.file.task));
    setValidation(undefined);
    setNotice(undefined);
  }, [project.file.task.taskId, project.path]);

  const task = draft;

  const apply = useMutation({
    mutationFn: async (next: TestTask) => await window.testforge.orchestration.updateTask(next),
    onSuccess: async (doc) => {
      client.setQueryData(["project-document"], doc);
      setDraft(structuredClone(doc.file.task));
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
      await client.invalidateQueries({ queryKey: ["project-document"] });
    }
  });

  const update = useCallback((next: TestTask) => { setDraft(next); setNotice(undefined); }, []);
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

  return <section className="suite-workspace">
    <div className="suite-toolbar">
      <Btn variant="subtle" icon={<IconRefresh size={14} />} onClick={() => { void client.invalidateQueries({ queryKey: ["project-document"] }); }}>刷新</Btn>
      <Btn variant="subtle" disabled={apply.isPending} onClick={() => apply.mutate(task)}>应用</Btn>
      <Btn variant="subtle" disabled={validate.isPending} onClick={() => validate.mutate(task)}>校验</Btn>
      <Btn
        variant="primary"
        icon={<IconPlay size={13} />}
        disabled={start.isPending}
        onClick={() => { if (task.inputs.length > 0) setRunInputsOpen(true); else start.mutate({}); }}
      >运行</Btn>
    </div>

    {(error || notice) && <div className={error ? "orchestration-error" : "orchestration-notice"}>{error ? <><IconAlert size={15} />{String(error)}</> : notice}</div>}

    <div className="suite-editor-grid" style={{ gridTemplateColumns: `150px minmax(0, 1fr)${editing ? ` 5px ${inspector.width}px` : ""}` }}>
      <StepPalette onAdd={addStep} />
      <div className="task-outline-pane">
        <VariableEditor task={task} onChange={update} />
        {SECTIONS.map((name) => <div className={`sequence-section${section === name ? " active" : ""}`} key={name} onClick={() => setSection(name)}>
          <h3>{SECTION_LABELS[name]} <Badge>{task[name].length}</Badge></h3>
          <StepOutline
            steps={task[name]}
            selected={selectedStepId}
            onSelect={setSelectedStepId}
            onEdit={setEditingStepId}
            onMove={(sourceId, targetId) => update(moveTaskStep(task, sourceId, targetId))}
          />
          {task[name].length === 0 && <div className="ide-empty">从左侧添加步骤</div>}
        </div>)}
        {validation && <ValidationPanel validation={validation} onSelect={setSelectedStepId} />}
      </div>
      {editing && <>
        <div className="col-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整步骤属性面板宽度" title="拖拽调整宽度" {...inspector.handleProps} />
        <aside className="step-inspector" aria-label="步骤属性">
          <header className="step-inspector-head">
            <strong>步骤属性 · {stepTypeLabel(editing.type)}</strong>
            <Btn variant="subtle" aria-label="关闭步骤属性" onClick={() => setEditingStepId(undefined)}>×</Btn>
          </header>
          <div className="step-inspector-body">
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
    <Modal
      open={Boolean(selectedRunId)}
      onClose={() => onRunSelected(undefined)}
      title="运行结果"
      width={760}
    >
      {selectedRunId && <RunInspector runId={selectedRunId} />}
    </Modal>

    <RunInputsModal
      open={runInputsOpen}
      inputs={task.inputs}
      pending={start.isPending}
      onClose={() => setRunInputsOpen(false)}
      onRun={(values) => start.mutate(values)}
    />
  </section>;
}
