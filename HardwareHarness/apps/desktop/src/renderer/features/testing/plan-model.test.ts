import { describe, expect, it } from "vitest";
import type { TestPlan } from "@hardwareharness/contracts/testing";
import { clonePlan, createStep, findStep, moveStep, planAnchors, planHardwareIds, removeStep } from "./plan-model.js";

function plan(): TestPlan {
  return {
    schemaVersion: 2,
    id: "plan",
    name: "Plan",
    description: "",
    revision: 1,
    parameters: [],
    requirements: [],
    stopOnFail: false,
    regions: {
      prepare: [],
      test: [
        { id: "group", type: "Group", children: [] },
        { id: "delay", type: "Delay", durationMs: 1 }
      ],
      cleanup: []
    },
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z"
  };
}

describe("test plan tree model", () => {
  it("moves a step into a structured container without changing its stable id", () => {
    const value = clonePlan(plan());
    moveStep(value, "delay", { region: "test", parentId: "group" });
    expect(value.regions.test).toHaveLength(1);
    expect(findStep(value, "delay")).toMatchObject({ parentId: "group", region: "test" });
  });

  it("refuses to move a parent into its own descendant", () => {
    const value = clonePlan(plan());
    moveStep(value, "delay", { region: "test", parentId: "group" });
    moveStep(value, "group", { region: "test", parentId: "delay" });
    expect(value.regions.test[0]?.id).toBe("group");
  });

  it("removes nested steps", () => {
    const value = clonePlan(plan());
    moveStep(value, "delay", { region: "test", parentId: "group" });
    removeStep(value, "delay");
    expect(findStep(value, "delay")).toBeUndefined();
  });

  it("collects concrete hardware bindings", () => {
    const value = clonePlan(plan());
    value.regions.test[0]!.children = [{
      id: "invoke", type: "InvokeTool", hardwareId: "old", toolName: "read", bindingRevision: "rev"
    }];
    expect(planHardwareIds(value)).toEqual(["old"]);
  });

  it("collects stream-step devices and the anchors tool calls set", () => {
    const value = clonePlan(plan());
    value.regions.test[0]!.children = [
      { id: "pulse", type: "InvokeTool", hardwareId: "gen", toolName: "pulse", anchor: "pulse" },
      { id: "again", type: "InvokeTool", hardwareId: "gen", toolName: "pulse", anchor: "pulse" },
      { id: "guard", type: "Guard", hardwareId: "scope", streamId: "ch1", children: [] }
    ];
    expect(planHardwareIds(value)).toEqual(["gen", "scope"]);
    expect(planAnchors(value)).toEqual([{ name: "pulse", hardwareId: "gen", stepId: "pulse" }]);
  });

  it("creates stream steps with their judging defaults", () => {
    const item = { category: "判定", label: "观测窗口", container: false, settingsSchema: {}, outputSchema: {} };
    expect(createStep({ ...item, type: "Observe" })).toMatchObject({
      window: { anchor: "", startMs: 0, endMs: 100 }, assertions: [], minSamples: 3
    });
    expect(createStep({ ...item, type: "Guard", container: true })).toMatchObject({
      children: [], condition: {}, onViolation: "abort"
    });
  });
});
