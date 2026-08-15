import type { TestTask } from "@testforge/contracts/orchestration";

export interface TaskDraftState {
  projectIdentity: string;
  base: TestTask;
  draft: TestTask;
  pendingExternal?: TestTask;
}

export function createTaskDraftState(projectIdentity: string, task: TestTask): TaskDraftState {
  return { projectIdentity, base: cloneTask(task), draft: cloneTask(task) };
}

export function updateTaskDraft(state: TaskDraftState, draft: TestTask): TaskDraftState {
  return { ...state, draft };
}

export function receiveExternalTask(state: TaskDraftState, projectIdentity: string, task: TestTask): TaskDraftState {
  if (state.projectIdentity !== projectIdentity) return createTaskDraftState(projectIdentity, task);
  if (tasksEqual(state.base, task) || (state.pendingExternal && tasksEqual(state.pendingExternal, task))) return state;
  if (!isTaskDraftDirty(state)) return createTaskDraftState(projectIdentity, task);
  return { ...state, pendingExternal: cloneTask(task) };
}

export function resolveExternalTask(state: TaskDraftState, choice: "keep-local" | "adopt-external"): TaskDraftState {
  if (!state.pendingExternal) return state;
  const external = cloneTask(state.pendingExternal);
  return choice === "adopt-external"
    ? { projectIdentity: state.projectIdentity, base: external, draft: cloneTask(external) }
    : { projectIdentity: state.projectIdentity, base: external, draft: state.draft };
}

export function acceptAppliedTask(state: TaskDraftState, task: TestTask): TaskDraftState {
  return createTaskDraftState(state.projectIdentity, task);
}

export function isTaskDraftDirty(state: TaskDraftState): boolean {
  return !tasksEqual(state.base, state.draft);
}

function tasksEqual(left: TestTask, right: TestTask): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneTask(task: TestTask): TestTask {
  return structuredClone(task);
}
