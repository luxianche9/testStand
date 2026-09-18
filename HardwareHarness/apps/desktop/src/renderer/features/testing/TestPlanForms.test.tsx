// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestExpressionReference, TestStep } from "@hardwareharness/contracts/testing";
import { BoundArgumentsForm, PlanParametersEditor, StepSettingsForm } from "./TestPlanForms.js";

afterEach(() => cleanup());

const references: TestExpressionReference[] = [{
  expression: "steps.measure.volts",
  label: "电压测量 / volts",
  sourceKind: "step",
  sourceId: "measure",
  path: "volts",
  valueType: "number",
  unit: "V",
  availability: "guaranteed"
}];

describe("test plan schema forms", () => {
  it("edits plan parameters as a typed list", () => {
    const onChange = vi.fn();
    render(<PlanParametersEditor value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "增加运行参数" }));
    expect(onChange).toHaveBeenCalledWith([{ name: "parameter1", type: "string", required: false }]);
  });

  it("switches InvokeTool arguments between fixed values and data references", () => {
    const onChange = vi.fn();
    render(<BoundArgumentsForm
      schema={{ type: "object", properties: { voltage: { type: "number", title: "目标电压", "x-hh-unit": "V" } }, required: ["voltage"] }}
      value={{ voltage: 3.3 }}
      references={references}
      onChange={onChange}
    />);
    fireEvent.change(screen.getByRole("combobox", { name: "voltage 绑定方式" }), { target: { value: "expression" } });
    expect(onChange).toHaveBeenLastCalledWith({ voltage: { expression: "steps.measure.volts" } });
  });

  it("keeps unsupported CEL in advanced mode until explicitly rebuilt", () => {
    const step: TestStep = { id: "condition", type: "If", condition: "size(variables.values) > 0" };
    const onChange = vi.fn();
    render(<StepSettingsForm
      step={step}
      catalogItem={{ type: "If", category: "流程控制", label: "条件", container: true, settingsSchema: { type: "object", properties: { condition: { type: "string", format: "hh-cel", title: "条件", "x-hh-expression-mode": "condition" } } }, outputSchema: {} }}
      references={references}
      onChange={onChange}
    />);
    expect(screen.getByText("当前表达式超出可视编辑范围。需要重建时可使用下方按钮。")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("size(variables.values) > 0");
    expect(onChange).not.toHaveBeenCalled();
  });
});
