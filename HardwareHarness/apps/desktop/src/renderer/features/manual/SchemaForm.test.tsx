// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaArgumentsForm } from "./SchemaForm.js";

afterEach(() => cleanup());

describe("SchemaArgumentsForm JSON fallback", () => {
  it("preserves declared hardwareId values for flow inputs", () => {
    const onChange = vi.fn();
    render(<SchemaArgumentsForm preserveHardwareId schema={{ type: "object" }} value={{}} onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: '{"hardwareId":"DUT_A","count":3}' } });
    expect(onChange).toHaveBeenLastCalledWith({ hardwareId: "DUT_A", count: 3 });
  });
  it("renders common oneOf branches without forcing JSON editing", async () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(<SchemaArgumentsForm
      schema={{
        oneOf: [{
          type: "object",
          properties: { hardwareId: { type: "string" }, channel: { type: "integer" } },
          required: ["hardwareId", "channel"]
        }]
      }}
      value={{ channel: 1 }}
      onChange={onChange}
      onValidityChange={onValidityChange}
    />);

    expect(screen.getByRole("combobox", { name: "Schema 分支" })).toBeTruthy();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith({ channel: 2 });
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
  });

  it("supports nullable fields and additionalProperties key-value rows", () => {
    const onChange = vi.fn();
    render(<SchemaArgumentsForm
      schema={{
        type: "object",
        properties: { note: { type: ["string", "null"] } },
        required: ["note"],
        additionalProperties: true
      }}
      value={{ note: null }}
      onChange={onChange}
    />);
    fireEvent.click(screen.getByRole("checkbox", { name: "使用空值" }));
    expect(onChange).toHaveBeenCalledWith({ note: "" });
    fireEvent.change(screen.getByRole("textbox", { name: "新增扩展键" }), { target: { value: "channel" } });
    fireEvent.click(screen.getByRole("button", { name: "增加键" }));
    expect(onChange).toHaveBeenLastCalledWith({ note: null, channel: "" });
  });
});
