// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  Input,
  SegmentedControl,
  VerdictBadge,
  formatDuration,
  useConfirm,
  verdictTone
} from "./index";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("Dialog", () => {
  it("portals into the overlay, is named by its title and closes on Escape", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent title="编辑设备">
          <DialogBody><input aria-label="名称" /></DialogBody>
          <DialogFooter><Button>保存</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );
    const dialog = screen.getByRole("dialog", { name: "编辑设备" });
    expect(dialog.parentElement).toBe(document.body.querySelector("[data-slot='dialog-overlay']"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing when closed", () => {
    render(
      <Dialog open={false}>
        <DialogContent title="编辑设备"><DialogBody>内容</DialogBody></DialogContent>
      </Dialog>
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves useConfirm with the chosen answer", async () => {
    let answer: Promise<boolean> | undefined;
    function Harness() {
      const [confirm, dialog] = useConfirm();
      return (
        <>
          <Button onClick={() => { answer = confirm({ title: "删除设备", message: "确定？", danger: true }); }}>
            删除
          </Button>
          {dialog}
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    await expect(answer).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("controls", () => {
  it("names icon buttons and links field labels to their control", () => {
    render(
      <>
        <IconButton label="刷新" onClick={() => undefined}>↻</IconButton>
        <Field label="端口名" error="必填"><Input /></Field>
      </>
    );
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
    expect(screen.getByLabelText("端口名").tagName).toBe("INPUT");
    expect(screen.getByText("必填")).toBeTruthy();
  });

  it("exposes segmented options as pressed toggle buttons in a named group", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="主题"
        value="dark"
        options={[{ value: "dark", label: "深色" }, { value: "light", label: "浅色" }]}
        onChange={onChange}
      />
    );
    expect(screen.getByRole("group", { name: "主题" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "浅色" }));
    expect(onChange).toHaveBeenCalledWith("light");
  });
});

describe("status", () => {
  it("maps verdicts to tones and labels", () => {
    expect(verdictTone("Pass")).toBe("pass");
    expect(verdictTone("Error")).toBe("fail");
    expect(verdictTone("Aborted")).toBe("invalid");
    expect(verdictTone(undefined)).toBe("neutral");
    render(<><VerdictBadge verdict="Fail" /><VerdictBadge verdict={undefined} /></>);
    expect(screen.getByText("FAIL").dataset.tone).toBe("fail");
    expect(screen.getByText("未运行")).toBeTruthy();
  });

  it("formats durations for readouts", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatDuration(42_100)).toBe("42.1 s");
    expect(formatDuration(125_000)).toBe("2:05");
  });
});
