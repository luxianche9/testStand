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
  it("blocks stale values while the JSON editor is invalid", async () => {
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

    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "{" } });
    expect(await screen.findByText("请输入合法 JSON")).toBeTruthy();
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "[]" } });
    expect(await screen.findByText("工具参数必须是 JSON object")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "{\"hardwareId\":\"spoofed\",\"channel\":2}" } });
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
    expect(onChange).toHaveBeenLastCalledWith({ channel: 2 });
  });
});
