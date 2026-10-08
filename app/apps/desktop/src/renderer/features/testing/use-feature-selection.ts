import { useCallback, useMemo, useState } from "react";
import type { FeatureSelection } from "./PlanFlow.js";

const storagePrefix = "teststand.unselected-features:";

function readUnselected(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Which 功能组 the next run runs, per project. The groups left out are remembered, so a group just
 * added to the flow starts ticked. `chosen` keeps the flow's order.
 */
export function useFeatureSelection(project: string | undefined, featureIds: readonly string[]) {
  const key = storagePrefix + (project ?? "");
  const [state, setState] = useState(() => ({ key, unselected: readUnselected(key) }));
  // Another project's flow: start from what was remembered for it.
  const unselected = state.key === key ? state.unselected : readUnselected(key);

  const onChange = useCallback((stepId: string, selected: boolean) => {
    const current = state.key === key ? state.unselected : readUnselected(key);
    const next = selected ? current.filter((item) => item !== stepId) : [...new Set([...current, stepId])];
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    setState({ key, unselected: next });
  }, [key, state]);

  return useMemo(() => {
    const left = new Set(unselected);
    const chosen = featureIds.filter((item) => !left.has(item));
    const selection: FeatureSelection = { selected: (stepId) => !left.has(stepId), onChange };
    return { selection, chosen, total: featureIds.length };
  }, [featureIds, onChange, unselected]);
}
