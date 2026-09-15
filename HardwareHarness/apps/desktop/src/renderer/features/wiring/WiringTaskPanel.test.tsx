// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-dom";
import { WiringTaskModal } from "./WiringTaskPanel";
import { WiringTaskInbox } from "../../app/WiringTaskInbox";

const hardware: Hardware[] = ["A", "B"].map((hardwareId) => ({
  formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
  ports: [{ portId: "J1", name: "J1", imageAssetId: "port.png", pins: [{ pinId: "1", position: 1, label: "PIN 1" }] }]
}));
const baseTask: WiringTask = {
  wiringTaskId: "task-1", action: "connect", portA: "A.J1", portB: "B.J1",
  pins: [{ a: "1", b: "1" }], hardwareIds: ["A", "B"], status: "pending",
  requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), warnings: []
};
function setup() {
  const startTask = vi.fn();
  const completeTask = vi.fn(async () => ({ ...baseTask, status: "confirmed" as const }));
  const hardwareImageUrl = vi.fn(async (id: string) => `https://example.test/${id}.png`);
  Object.defineProperty(window, "hardwareharness", { configurable: true, value: {
    wiring: { startTask, completeTask }, devices: { hardwareImageUrl }
  } as unknown as HardwareHarnessApi });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChanged = vi.fn(async () => undefined);
  const onClose = vi.fn();
  const show = (task = baseTask) => <QueryClientProvider client={client}><WiringTaskModal task={task} hardware={hardware} onChanged={onChanged} onClose={onClose} /></QueryClientProvider>;
  return { client, startTask, completeTask, onChanged, onClose, show };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("WiringTaskModal", () => {
  it("confirms directly and renders completed history without another action", async () => {
    const { show, startTask, completeTask, onChanged } = setup();
    const view = render(show());
    expect(screen.queryByRole("button", { name: "开始处理" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "已完成" }));
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith("task-1", "confirmed"));
    expect(startTask).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    view.rerender(show({ ...baseTask, status: "confirmed" }));
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "已完成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "无法完成" })).toBeNull();
  });
  it.each(["cancelled", "timed_out", "failed", "rejected"] as const)("opens %s history read-only", (status) => {
    const { show } = setup();
    render(show({ ...baseTask, status }));
    expect(screen.queryByRole("button", { name: "已完成" })).toBeNull();
  });
  it("opens the full photo and closes only the preview with Escape", async () => {
    const { show, onClose } = setup();
    render(show());
    await userEvent.click(await screen.findByRole("button", { name: "查看全图：A · J1" }));
    const preview = screen.getByRole("dialog", { name: "A · J1" });
    expect(within(preview).getByRole("img").getAttribute("src")).toBe("https://example.test/A.png");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "A · J1" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "接线任务" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("can close a pending request without changing its backend state", async () => {
    const { show, onClose, startTask, completeTask } = setup();
    render(show());
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(startTask).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
  });
  it("shows errors and leaves confirmation available for a retry", async () => {
    const { show, completeTask } = setup();
    completeTask.mockRejectedValueOnce(new Error("connection lost"));
    render(show());
    await userEvent.click(screen.getByRole("button", { name: "已完成" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "connection lost");
    expect(screen.getByRole("button", { name: "已完成" }).hasAttribute("disabled")).toBe(false);
  });
  it("keeps dismissed requests closed across refreshes and reopens pending or completed inbox entries", async () => {
    const { client, completeTask } = setup();
    function Harness({ tasks }: { tasks: WiringTask[] }) {
      const [open, setOpen] = useState(false);
      return <QueryClientProvider client={client}>
        <button onClick={() => setOpen(true)}>信箱</button>
        <WiringTaskInbox tasks={tasks} hardware={hardware} mailboxOpen={open} onCloseMailbox={() => setOpen(false)} />
      </QueryClientProvider>;
    }
    const view = render(<Harness tasks={[baseTask]} />);
    await userEvent.click(await screen.findByRole("button", { name: "关闭" }));
    view.rerender(<Harness tasks={[{ ...baseTask }]} />);
    expect(screen.queryByRole("dialog", { name: "接线任务" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "信箱" }));
    await userEvent.click(screen.getByRole("button", { name: /待处理.*连接/ }));
    await userEvent.click(screen.getByRole("button", { name: "已完成" }));
    await waitFor(() => expect(completeTask).toHaveBeenCalledOnce());
    view.rerender(<Harness tasks={[{ ...baseTask, status: "confirmed" }]} />);
    await userEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "信箱" }));
    await userEvent.click(screen.getByRole("button", { name: /已完成.*连接/ }));
    expect(screen.getByRole("dialog", { name: "接线任务" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "已完成" })).toBeNull();
  });
});
