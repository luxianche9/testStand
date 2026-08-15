// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Btn, Modal } from "./ui.js";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("Modal accessibility", () => {
  it("portals, traps focus, locks scrolling, and restores focus", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开";
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(<Modal open title="编辑设备" onClose={onClose} footer={<Btn>保存</Btn>}><input aria-label="名称" /></Modal>);

    const dialog = screen.getByRole("dialog", { name: "编辑设备" });
    expect(dialog.parentElement).toBe(document.body.querySelector(".modal-overlay"));
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("button", { name: "关闭" })).toBe(document.activeElement);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "保存" })).toBe(document.activeElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(<Modal open={false} title="编辑设备" onClose={onClose}><span /></Modal>);
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toBe(document.activeElement);
    trigger.remove();
  });

  it("does not expose close behavior for a blocking modal", () => {
    render(<Modal open title="等待操作员"><Btn>确认</Btn></Modal>);
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "等待操作员" })).toBeTruthy();
  });
});
