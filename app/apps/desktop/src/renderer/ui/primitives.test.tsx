// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTrigger } from "./dialog";
import { Input, Select } from "./field";
import { ToastProvider, useToast } from "./toast";
import { Checkbox } from "./toggle";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ui primitive behavior", () => {
  it("keeps native Select empty values, option groups, disabled options, refs and form data", async () => {
    const ref = createRef<HTMLSelectElement>();
    const changes: string[] = [];
    function Fixture() {
      const [value, setValue] = useState("");
      return <form aria-label="接线">
        <Select ref={ref} name="port" aria-label="端口" className="w-auto" value={value} onChange={(event) => {
          changes.push(event.target.value);
          setValue(event.target.value);
        }}>
          <option value="">选择端口</option>
          <optgroup label="设备一">
            <option value="a">端口 A</option>
            <option value="b" disabled>端口 B</option>
          </optgroup>
        </Select>
      </form>;
    }
    render(<Fixture />);
    const control = screen.getByRole<HTMLSelectElement>("combobox", { name: "端口" });
    expect(ref.current).toBe(control);
    expect(control.parentElement?.classList.contains("w-auto")).toBe(true);
    expect(control.querySelector("optgroup")?.label).toBe("设备一");
    expect(control.value).toBe("");
    await userEvent.selectOptions(control, "a");
    expect(new FormData(screen.getByRole<HTMLFormElement>("form")).get("port")).toBe("a");
    await userEvent.selectOptions(control, "b");
    expect(control.value).toBe("a");
    await userEvent.selectOptions(control, "");
    expect(control.value).toBe("");
    expect(changes).toEqual(["a", ""]);
  });

  it("keeps native Select compatible with react-hook-form registration and reset", async () => {
    const submitted = vi.fn();
    function Fixture() {
      const { register, handleSubmit, reset } = useForm({ defaultValues: { shell: "powershell" } });
      return <form onSubmit={handleSubmit(submitted)}>
        <Select aria-label="远程 Shell" {...register("shell")}>
          <option value="powershell">PowerShell</option><option value="posix">POSIX sh</option>
        </Select>
        <Button onClick={() => reset({ shell: "powershell" })}>重置</Button>
        <Button type="submit">保存</Button>
      </form>;
    }
    render(<Fixture />);
    const control = screen.getByRole<HTMLSelectElement>("combobox");
    await userEvent.selectOptions(control, "posix");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(submitted.mock.calls[0]?.[0]).toEqual({ shell: "posix" }));
    await userEvent.click(screen.getByRole("button", { name: "重置" }));
    expect(control.value).toBe("powershell");
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("preserves Button default type, explicit submit, refs and asChild composition", async () => {
    const submitted = vi.fn();
    const parentClick = vi.fn();
    const childClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(<form onSubmit={(event) => { event.preventDefault(); submitted(); }}>
      <Button ref={ref}>普通按钮</Button>
      <Button type="submit">提交</Button>
      <Button asChild onClick={parentClick}><button onClick={childClick}>组合按钮</button></Button>
      <Button disabled>禁用按钮</Button>
    </form>);
    expect(ref.current).toBe(screen.getByRole("button", { name: "普通按钮" }));
    await userEvent.click(screen.getByRole("button", { name: "普通按钮" }));
    await userEvent.click(screen.getByRole("button", { name: "组合按钮" }));
    expect(submitted).not.toHaveBeenCalled();
    expect(parentClick).toHaveBeenCalledOnce();
    expect(childClick).toHaveBeenCalledOnce();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "禁用按钮" }).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("preserves Checkbox false, true and indeterminate states and native label activation", async () => {
    const changed = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const view = render(<>
      <label htmlFor="enabled">启用</label>
      <Checkbox ref={ref} id="enabled" checked="indeterminate" onCheckedChange={changed} />
    </>);
    const control = screen.getByRole("checkbox", { name: "启用" });
    expect(ref.current).toBe(control);
    expect(control.getAttribute("aria-checked")).toBe("mixed");
    await userEvent.click(screen.getByText("启用"));
    expect(changed).toHaveBeenLastCalledWith(true);
    view.rerender(<Checkbox aria-label="启用" checked onCheckedChange={changed} />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("checkbox"));
    expect(changed).toHaveBeenLastCalledWith(false);
    view.rerender(<Checkbox aria-label="启用" checked={false} disabled onCheckedChange={changed} />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    await userEvent.click(screen.getByRole("checkbox"));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("preserves nested Dialog portals, Escape order and focus restoration", async () => {
    render(<Dialog>
      <DialogTrigger asChild><Button>打开编辑器</Button></DialogTrigger>
      <DialogContent title="编辑器">
        <Input aria-label="名称" />
        <Dialog>
          <DialogTrigger asChild><Button>预览图片</Button></DialogTrigger>
          <DialogContent title="图片"><Button>关闭前的焦点</Button></DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>);
    await userEvent.click(screen.getByRole("button", { name: "打开编辑器" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "名称" })));
    const preview = screen.getByRole("button", { name: "预览图片" });
    await userEvent.click(preview);
    const overlay = screen.getByRole("dialog", { name: "图片" }).closest('[data-slot="dialog-overlay"]');
    expect(overlay?.parentElement).toBe(document.body);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "编辑器" })).toBeDefined();
    expect(document.activeElement).toBe(preview);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开编辑器" }));
  });

  it("preserves Toast capacity, durations, error copying and dismissal", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    function Fixture() {
      const toast = useToast();
      return <>
        <Button onClick={() => {
          toast.success("one"); toast.info("two"); toast.success("three"); toast.info("four"); toast.error("failure");
        }}>通知</Button>
      </>;
    }
    render(<ToastProvider><Fixture /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getAllByRole("alert")).toHaveLength(4);
    expect(screen.queryByText("one")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制错误" }));
    expect(writeText).toHaveBeenCalledWith("failure");
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("failure")).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]!);
    expect(screen.getAllByRole("alert")).toHaveLength(3);
  });
});
