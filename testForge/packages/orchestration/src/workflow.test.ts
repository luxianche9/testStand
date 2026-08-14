import { describe, expect, it } from "vitest";
import type { TestTask } from "@testforge/contracts/orchestration";
import { createWorkflowContext, evaluateWorkflowExpression, getWorkflowPath, resolveWorkflowValue, validateTestTask } from "./workflow.js";

describe("workflow model", () => {
  it("evaluates safe structured expressions and value templates", () => {
    const context = { voltage: 28.4, limits: { low: 27 }, flags: [true, false] };
    expect(evaluateWorkflowExpression({
      kind: "logical", operator: "and", operands: [
        { kind: "binary", operator: "gt", left: { kind: "variable", path: "voltage" }, right: { kind: "variable", path: "limits.low" } },
        { kind: "unary", operator: "not", operand: { kind: "literal", value: false } }
      ]
    }, context)).toBe(true);
    expect(resolveWorkflowValue({ kind: "object", entries: { measured: { kind: "variable", path: "voltage" } } }, context)).toEqual({ measured: 28.4 });
  });

  it("uses null-prototype contexts and rejects unsafe or undeclared paths", () => {
    const task: TestTask = { formatVersion: 2, taskId: "TASK", name: "Task", inputs: [{ name: "input", type: "object" }], variables: [], setup: [], steps: [{ stepId: "A", label: "Assert", enabled: true, type: "assert", expression: { kind: "variable", path: "missing.value" }, message: "bad" }], cleanup: [] };
    const context = createWorkflowContext(task, { input: { value: 1 } });
    expect(Object.getPrototypeOf(context)).toBeNull();
    expect(getWorkflowPath(context, "input.value")).toBe(1);
    expect(() => getWorkflowPath(context, "input.constructor")).toThrow(/Unsafe/);
    expect(validateTestTask(task).issues.some((item) => item.code === "undeclared_variable")).toBe(true);
  });
});
