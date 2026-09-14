// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "./ui/dialog";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("Dialog accessibility", () => {
  it("portals, focuses the close button, and closes on Escape", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader title="编辑设备" onClose={() => onOpenChange(false)} />
          <DialogBody><input aria-label="名称" /></DialogBody>
          <DialogFooter><Button>保存</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );

    const dialog = screen.getByRole("dialog", { name: "编辑设备" });
    expect(dialog.parentElement).toBe(document.body.querySelector("[data-slot='dialog-overlay'], .fixed"));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not render content when closed", () => {
    render(
      <Dialog open={false}>
        <DialogContent>
          <DialogHeader title="编辑设备" />
          <DialogBody><span>内容</span></DialogBody>
        </DialogContent>
      </Dialog>
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
