import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TestBatch, TestItemStatus, TestItemStatusList } from "@teststand/contracts/testing";
import { invalidateTestingData } from "../../lib/mutations.js";
import { queryKeys } from "../../lib/query-keys.js";
import { useToast } from "../../ui/toast.js";
import type { ItemPrompt } from "./ItemDialogs.js";
import { orderedSelection } from "./item-status.js";
import type { PlanEditor } from "./usePlanEditor.js";

type Confirm = (options: { title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean })
  => Promise<boolean>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
}

/** Item-list commands: create / rename / delete, reorder, and batch start / abort. */
export function useItemActions({ editor, items, confirm }: {
  editor: PlanEditor;
  items: TestItemStatus[];
  confirm: Confirm;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [stopOnFail, setStopOnFail] = useState(false);
  const [prompt, setPrompt] = useState<ItemPrompt>();

  const setStatus = (update: (current: TestItemStatusList) => TestItemStatusList) =>
    client.setQueryData<TestItemStatusList>(queryKeys.testItemStatus, (current) => current && update(current));

  const create = async (name: string) => {
    const result = await window.teststand.testing.createPlan({ input: { requestId: crypto.randomUUID(), name } });
    setPrompt(undefined);
    await invalidateTestingData(client);
    await editor.selectPlan(result.plan.id);
  };

  const rename = async (planId: string, name: string) => {
    const open = editor.draft?.id === planId;
    if (open && editor.dirty) {
      editor.mutate((next) => { next.name = name; });
      editor.setMessage("名称已修改，保存后生效");
    } else {
      const plan = await window.teststand.testing.loadPlan({ planId });
      const saved = await window.teststand.testing.savePlan({
        plan: { ...plan, name },
        baseRevision: plan.revision
      });
      if (open) editor.adopt(saved.plan);
      await invalidateTestingData(client);
    }
    setPrompt(undefined);
  };

  const remove = async (item: TestItemStatus) => {
    const ok = await confirm({
      title: "删除功能测试项？",
      message: `确定删除「${item.name}」吗？它的测试流程会被移除，历史运行记录保留。`,
      confirmLabel: "删除",
      danger: true
    });
    if (!ok) return;
    try {
      await window.teststand.testing.deletePlan({ planId: item.planId });
      setChecked((current) => { const next = new Set(current); next.delete(item.planId); return next; });
      await invalidateTestingData(client);
      if (editor.selectedPlanId === item.planId) editor.closePlan();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const reorder = async (planIds: string[]) => {
    const order = new Map(planIds.map((id, index) => [id, index]));
    setStatus((current) => ({
      ...current,
      items: [...current.items].sort((a, b) => (order.get(a.planId) ?? 0) - (order.get(b.planId) ?? 0))
    }));
    try {
      const result = await window.teststand.testing.reorderItems({ input: { planIds } });
      client.setQueryData(queryKeys.testItemStatus, result);
    } catch (error) {
      toast.error(errorText(error));
      await client.invalidateQueries({ queryKey: queryKeys.testItemStatus });
    }
  };

  /** Starts a batch over `planIds` (list order); the open draft is saved first so it runs as edited. */
  const startBatch = async (planIds: string[]) => {
    if (!planIds.length) return;
    if (editor.conflict) { editor.setMessage("请先解决计划冲突再启动运行。"); return; }
    if (editor.dirty && editor.draft && planIds.includes(editor.draft.id) && !await editor.save()) return;
    try {
      const batch = await window.teststand.testing.startBatch({
        input: { requestId: crypto.randomUUID(), planIds, stopOnFail }
      });
      setStatus((current) => ({ ...current, batch }));
      await invalidateTestingData(client);
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  const orderedChecked = orderedSelection(items, checked);
  const runSelected = () => startBatch(orderedChecked);

  const abortBatch = async (batch: TestBatch | undefined) => {
    if (!batch) return;
    const ok = await confirm({
      title: "中止批量运行？",
      message: "当前功能测试项会被终止并进入清理流程，剩余项不再运行。",
      confirmLabel: "中止",
      danger: true
    });
    if (!ok) return;
    try {
      const next = await window.teststand.testing.abortBatch({ batchId: batch.batchId });
      setStatus((current) => ({ ...current, batch: next }));
      await invalidateTestingData(client);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return {
    checked, setChecked, checkedCount: orderedChecked.length, stopOnFail, setStopOnFail, prompt, setPrompt,
    create, rename, remove, reorder, runSelected, abortBatch
  };
}
