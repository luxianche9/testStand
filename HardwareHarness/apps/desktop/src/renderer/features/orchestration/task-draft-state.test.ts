import { describe, expect, it } from "vitest";
import type { TestTask } from "@hardwareharness/contracts/orchestration";
import {
  createTaskDraftState,
  isTaskDraftDirty,
  receiveExternalTask,
  resolveExternalTask,
  updateTaskDraft
} from "./task-draft-state.js";

describe("task draft external updates", () => {
  it("adopts an external update immediately while the draft is clean", () => {
    const next = receiveExternalTask(createTaskDraftState("project-a", task("base")), "project-a", task("external"));
    expect(next.draft.name).toBe("external");
    expect(next.pendingExternal).toBeUndefined();
    expect(isTaskDraftDirty(next)).toBe(false);
  });

  it("preserves a dirty draft and exposes the external version as a conflict", () => {
    const dirty = updateTaskDraft(createTaskDraftState("project-a", task("base")), task("local"));
    const next = receiveExternalTask(dirty, "project-a", task("external"));
    expect(next.draft.name).toBe("local");
    expect(next.pendingExternal?.name).toBe("external");
  });

  it("can keep local edits without repeatedly reporting the same external version", () => {
    const dirty = updateTaskDraft(createTaskDraftState("project-a", task("base")), task("local"));
    const conflicted = receiveExternalTask(dirty, "project-a", task("external"));
    const kept = resolveExternalTask(conflicted, "keep-local");
    const repeated = receiveExternalTask(kept, "project-a", task("external"));
    expect(repeated.draft.name).toBe("local");
    expect(repeated.pendingExternal).toBeUndefined();
    expect(isTaskDraftDirty(repeated)).toBe(true);
  });

  it("can adopt the external version and discard the local draft explicitly", () => {
    const dirty = updateTaskDraft(createTaskDraftState("project-a", task("base")), task("local"));
    const resolved = resolveExternalTask(receiveExternalTask(dirty, "project-a", task("external")), "adopt-external");
    expect(resolved.draft.name).toBe("external");
    expect(resolved.pendingExternal).toBeUndefined();
    expect(isTaskDraftDirty(resolved)).toBe(false);
  });

  it("always resets when the project identity changes", () => {
    const dirty = updateTaskDraft(createTaskDraftState("project-a", task("base")), task("local"));
    const next = receiveExternalTask(dirty, "project-b", task("other-project"));
    expect(next.projectIdentity).toBe("project-b");
    expect(next.draft.name).toBe("other-project");
    expect(next.pendingExternal).toBeUndefined();
  });
});

function task(name: string): TestTask {
  return {
    formatVersion: 2,
    taskId: "TASK",
    name,
    inputs: [],
    variables: [],
    setup: [],
    steps: [],
    cleanup: []
  };
}
