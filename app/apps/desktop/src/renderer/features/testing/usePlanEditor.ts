import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TestPlan, TestPlanDraftAnalysis, TestPlanIssue } from "@teststand/contracts/testing";
import { invalidateTestingData } from "../../lib/mutations.js";
import { queryKeys } from "../../lib/query-keys.js";
import { useKeyboardShortcut } from "../../lib/hooks/useKeyboardShortcut.js";
import { FLOW_ID, defaultRunParameters } from "./plan-helpers.js";
import { clonePlan, findStep } from "./plan-model.js";

type Confirm = (options: { title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean })
  => Promise<boolean>;

const historyLimit = 50;

function errorText(error: unknown): string {
  return (error as { message?: string } | undefined)?.message ?? String(error);
}

/**
 * Draft editing of the project's test flow: undo/redo, save with conflict detection, validation,
 * debounced draft analysis, AI-revision conflict handling and run start with the chosen 功能组.
 */
export function usePlanEditor({ confirm, onRunStarted }: {
  confirm: Confirm;
  onRunStarted: (runId: string) => void;
}) {
  const client = useQueryClient();
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [draft, setDraft] = useState<TestPlan>();
  const [selectedStepId, setSelectedStepId] = useState<string>();
  const [past, setPast] = useState<TestPlan[]>([]);
  const [future, setFuture] = useState<TestPlan[]>([]);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [issues, setIssues] = useState<TestPlanIssue[]>([]);
  const [draftAnalysis, setDraftAnalysis] = useState<TestPlanDraftAnalysis>();
  const [message, setMessage] = useState<string>();
  const [runParameters, setRunParameters] = useState<Record<string, unknown>>({});
  const loadToken = useRef(0);

  /** Shows `plan`; `keepStep` keeps the selected step when it still exists (a reload of the same plan). */
  const adopt = useCallback((plan: TestPlan, keepStep = false) => {
    setSelectedPlanId(plan.id);
    setDraft(plan);
    setSelectedStepId((current) => keepStep && current && findStep(plan, current) ? current : undefined);
    setPast([]);
    setFuture([]);
    setDirty(false);
    setConflict(false);
    setIssues([]);
    setDraftAnalysis(undefined);
    setRunParameters(defaultRunParameters(plan));
  }, []);

  const loadPlan = useCallback(async (id: string = FLOW_ID, keepStep = false) => {
    const token = ++loadToken.current;
    setSelectedPlanId(id);
    try {
      const plan = await window.teststand.testing.loadPlan({ planId: id });
      if (token === loadToken.current) { adopt(plan, keepStep); setMessage(undefined); }
    } catch (error) {
      if (token === loadToken.current) setMessage(errorText(error));
    }
  }, [adopt]);

  useEffect(() => window.teststand.events.subscribe("testPlan", (payload) => {
    const event = payload as { planId?: string; revision?: number };
    if (!selectedPlanId || event.planId !== selectedPlanId) return;
    // Events of our own saves can arrive after a later revision is already shown.
    if (draft && typeof event.revision === "number" && event.revision <= draft.revision) return;
    if (dirty) setConflict(true);
    else void loadPlan(selectedPlanId, true);
  }), [selectedPlanId, draft, dirty, loadPlan]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!draft) { setDraftAnalysis(undefined); return; }
    let stopped = false;
    const timer = window.setTimeout(() => {
      void window.teststand.testing.analyzePlanDraft({ input: { plan: draft, baseRevision: draft.revision } })
        .then((analysis) => { if (!stopped) setDraftAnalysis(analysis); })
        .catch(() => { if (!stopped) setDraftAnalysis(undefined); });
    }, 320);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [draft]);

  const mutate = (change: (next: TestPlan) => void) => {
    if (!draft) return;
    const next = clonePlan(draft);
    change(next);
    setPast((items) => [...items.slice(-(historyLimit - 1)), draft]);
    setFuture([]);
    setDraft(next);
    setDirty(true);
    setMessage(undefined);
  };
  const undo = () => {
    const previous = past.at(-1);
    if (!previous || !draft) return;
    setPast(past.slice(0, -1));
    setFuture([draft, ...future]);
    setDraft(previous);
    setDirty(true);
  };
  const redo = () => {
    const next = future[0];
    if (!next || !draft) return;
    setFuture(future.slice(1));
    setPast([...past, draft]);
    setDraft(next);
    setDirty(true);
  };

  const save = async (): Promise<boolean> => {
    if (!draft || conflict) return false;
    try {
      const result = await window.teststand.testing.savePlan({ plan: draft, baseRevision: draft.revision });
      setDraft(result.plan);
      setIssues(result.issues);
      setDirty(false);
      setConflict(false);
      setPast([]);
      setFuture([]);
      setMessage("已保存");
      await invalidateTestingData(client);
      return true;
    } catch (error) {
      if ((error as { category?: string }).category === "conflict") setConflict(true);
      setMessage(errorText(error));
      return false;
    }
  };
  useKeyboardShortcut("s", () => void save(), Boolean(draft));

  const validate = async () => {
    if (!draft || dirty) { setMessage("请先保存当前草稿再校验。"); return; }
    try {
      const result = await window.teststand.testing.validatePlan({ planId: draft.id });
      setIssues(result.issues);
      setMessage(result.valid ? "校验通过" : "计划存在阻止运行的问题");
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  /** Starts a run of the flow; `features` are the 功能组 to run (all of them when omitted). */
  const start = async (features?: string[]) => {
    if (!draft || conflict) { setMessage("请先解决计划冲突再启动运行。"); return; }
    try {
      if (dirty && !await save()) return;
      const latest = dirty ? await window.teststand.testing.loadPlan({ planId: draft.id }) : draft;
      const validation = await window.teststand.testing.validatePlan({ planId: latest.id });
      setIssues(validation.issues);
      if (!validation.valid) { setMessage("校验未通过，未启动运行。"); return; }
      const run = await window.teststand.testing.startRun({
        input: {
          planId: latest.id,
          revision: validation.revision,
          executionRevision: validation.executionRevision,
          requestId: crypto.randomUUID(),
          parameters: runParameters,
          ...features ? { features } : {}
        }
      });
      // The signal view is live as soon as it knows the run is the current one: tell it first.
      client.setQueryData(queryKeys.testRun, run);
      onRunStarted(run.runId);
      await invalidateTestingData(client);
      setMessage("测试运行已启动");
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  /** Keeps the local draft over a conflicting revision: saves it on top of the stored one. */
  const overwrite = async () => {
    if (!draft) return;
    try {
      const latest = await window.teststand.testing.loadPlan({ planId: draft.id });
      const result = await window.teststand.testing.savePlan({
        plan: { ...draft, revision: latest.revision }, baseRevision: latest.revision
      });
      setDraft(result.plan);
      setIssues(result.issues);
      setDirty(false);
      setConflict(false);
      setMessage("已用本地草稿覆盖");
      await invalidateTestingData(client);
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const applyBinding = async (stepId: string, hardwareId: string, toolName: string, refresh = false) => {
    if (!draft || conflict) return;
    try {
      if (dirty && !await save()) return;
      const latest = await window.teststand.testing.loadPlan({ planId: draft.id });
      const result = await window.teststand.testing.applyPlanOperations({
        input: {
          planId: latest.id,
          baseRevision: latest.revision,
          requestId: crypto.randomUUID(),
          operations: [refresh
            ? { type: "refresh_invoke_binding", stepId }
            : { type: "bind_invoke_tool", stepId, hardwareId, toolName }]
        }
      });
      setDraft(result.plan);
      setIssues(result.issues);
      setDirty(false);
      setPast([]);
      setFuture([]);
      setMessage("工具绑定已更新");
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  /** Drops local edits and reloads the stored revision. */
  const discard = async () => { if (selectedPlanId) await loadPlan(selectedPlanId); };

  return {
    selectedPlanId, draft, selectedStepId, setSelectedStepId, past: past.length, future: future.length,
    dirty, conflict, issues, draftAnalysis, message, setMessage, runParameters, setRunParameters,
    adopt, loadPlan, discard, mutate, undo, redo, save, validate, start, overwrite, applyBinding
  };
}

export type PlanEditor = ReturnType<typeof usePlanEditor>;
