import { describe, expect, it } from "vitest";
import type { TestPlan } from "@hardwareharness/contracts/testing";
import { clonePlan, findStep, moveStep, planHardwareIds, removeStep, replaceHardware } from "./plan-model.js";

function plan(): TestPlan {
  return {
    schemaVersion: 1,
    id: "plan",
    name: "Plan",
    description: "",
    revision: 1,
    parameters: [],
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

  it("replaces concrete hardware bindings and invalidates their contracts", () => {
    const value = clonePlan(plan());
    value.regions.test[0]!.children = [{ id: "invoke", type: "InvokeTool", hardwareId: "old", toolName: "read", toolContractRevision: "rev", inputSchemaHash: "hash" }];
    expect(planHardwareIds(value)).toEqual(["old"]);
    replaceHardware(value, "old", "new");
    const invoke = findStep(value, "invoke")!.step;
    expect(invoke.hardwareId).toBe("new");
    expect(invoke.toolName).toBe("read");
    expect(invoke.toolContractRevision).toBeUndefined();
    expect(invoke.inputSchemaHash).toBeUndefined();
  });
});
