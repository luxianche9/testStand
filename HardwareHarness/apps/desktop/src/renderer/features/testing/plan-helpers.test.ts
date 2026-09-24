import { describe, expect, it } from "vitest";
import type { TestPlan } from "@hardwareharness/contracts/testing";
import {
  collectReferenceCounts, duplicateStep, insertStepAt, mergeRuns, moveStepTo, patchStep, stepIdForIssuePath
} from "./plan-helpers.js";
import { findStep } from "./plan-model.js";
import { makePlan, makeSummary } from "./testing-api.fixture.js";

function plan(): TestPlan {
  return {
    ...makePlan(),
    regions: {
      prepare: [{ id: "setup", type: "Delay" }],
      test: [
        { id: "group", type: "Group", children: [{ id: "measure", type: "InvokeTool" }] },
        { id: "check", type: "AssertRange", value: "steps.measure.volts > 3" }
      ],
      cleanup: []
    }
  };
}

describe("plan helpers", () => {
  it("resolves nested validation paths to the deepest step", () => {
    expect(stepIdForIssuePath(plan(), "regions/test/0/children/0/arguments")).toBe("measure");
    expect(stepIdForIssuePath(plan(), "regions/test/1")).toBe("check");
    expect(stepIdForIssuePath(plan(), "parameters/0")).toBeUndefined();
  });

  it("inserts at region end, inside containers and before plain steps", () => {
    const value = plan();
    insertStepAt(value, { id: "a", type: "Delay" }, "region:cleanup");
    insertStepAt(value, { id: "b", type: "Delay" }, "group");
    insertStepAt(value, { id: "c", type: "Delay" }, "check");
    expect(value.regions.cleanup.map((step) => step.id)).toEqual(["a"]);
    expect(value.regions.test[0]!.children!.map((step) => step.id)).toEqual(["measure", "b"]);
    expect(value.regions.test.map((step) => step.id)).toEqual(["group", "c", "check"]);
  });

  it("moves steps onto regions and containers", () => {
    const value = plan();
    moveStepTo(value, "setup", "group");
    expect(findStep(value, "setup")?.parentId).toBe("group");
    moveStepTo(value, "check", "region:prepare");
    expect(value.regions.prepare.map((step) => step.id)).toEqual(["check"]);
  });

  it("duplicates with fresh ids and patches or clears fields", () => {
    const value = plan();
    duplicateStep(value, "group");
    const copy = value.regions.test[1]!;
    expect(copy.id).not.toBe("group");
    expect(copy.name).toBe("Group 副本");
    expect(copy.children![0]!.id).not.toBe("measure");
    patchStep(value, "check", { name: "阈值", value: undefined });
    expect(findStep(value, "check")?.step).toEqual({ id: "check", type: "AssertRange", name: "阈值" });
  });

  it("counts step references and merges run pages without duplicates", () => {
    expect(collectReferenceCounts(plan())).toEqual({ measure: 1 });
    const first = makeSummary("run-1", "A", "2026-09-18T00:00:00Z");
    const merged = mergeRuns([first], [{ ...first, planName: "B" }, makeSummary("run-2", "C", first.startedAt)]);
    expect(merged.map((run) => `${run.runId}:${run.planName}`)).toEqual(["run-1:B", "run-2:C"]);
  });
});
