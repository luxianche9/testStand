// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { WiringChange, WiringTask } from "@hardwareharness/contracts/wiring";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-dom";
import { WiringLogPanel } from "./WiringLogPanel";
import { WiringTaskCard } from "./WiringTaskCard";
import { extractTask } from "./wiring-model";

const hardware: Hardware[] = ["A", "B"].map((hardwareId) => ({
  formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
  ports: [{ portId: "J1", name: "J1", imageAssetId: "port.png", pins: [{ pinId: "1", position: 1, label: "PIN 1" }] }]
}));
const baseTask: WiringTask = {
  wiringTaskId: "task-1", action: "connect", portA: "A.J1", portB: "B.J1",
  pins: [{ a: "1", b: "1" }], hardwareIds: ["A", "B"], status: "pending",
  requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), warnings: []
};
const history: WiringTask = {
  ...baseTask, wiringTaskId: "task-0", status: "confirmed",
  requestedAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:05:00.000Z"
};
const manual: WiringChange = {
  entryId: "change-1", kind: "removed", connectionId: "c1", portA: "A.J1", portB: "B.J1",
  pins: [], at: "2026-01-03T00:00:00.000Z"
};

function setup() {
  const startTask = vi.fn();
  const completeTask = vi.fn(async () => ({ ...baseTask, status: "confirmed" as const }));
  const listTasks = vi.fn(async (): Promise<WiringTask[]> => [baseTask]);
  const listChanges = vi.fn(async (): Promise<WiringChange[]> => []);
  const hardwareImageUrl = vi.fn(async (id: string) => `https://example.test/${id}.png`);
  Object.defineProperty(window, "hardwareharness", { configurable: true, value: {
    wiring: { startTask, completeTask, listTasks, listChanges }, devices: { hardwareImageUrl }
  } as unknown as HardwareHarnessApi });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChanged = vi.fn(async () => undefined);
  const card = (task = baseTask) => (
    <QueryClientProvider client={client}>
      <WiringTaskCard task={task} hardware={hardware} onChanged={onChanged} />
    </QueryClientProvider>
  );
  const panel = () => <QueryClientProvider client={client}><WiringLogPanel hardware={hardware} /></QueryClientProvider>;
  return { startTask, completeTask, listTasks, listChanges, onChanged, card, panel };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("WiringTaskCard", () => {
  it.each([["完成", "confirmed"], ["未完成", "rejected"]] as const)("answers with %s directly", async (label, outcome) => {
    const { card, startTask, completeTask, onChanged } = setup();
    render(card());
    await userEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith("task-1", outcome));
    expect(startTask).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });
  it.each(["confirmed", "cancelled", "timed_out", "failed", "rejected"] as const)("shows %s read-only", (status) => {
    const { card } = setup();
    render(card({ ...baseTask, status }));
    expect(screen.queryByRole("button", { name: "完成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "未完成" })).toBeNull();
  });
  it("opens the full photo in a zoomable viewer and closes it with Escape", async () => {
    const { card } = setup();
    render(card());
    await userEvent.click(await screen.findByRole("button", { name: "查看全图：A · J1" }));
    const preview = screen.getByRole("dialog", { name: "A · J1" });
    expect(within(preview).getByRole("img").getAttribute("src")).toBe("https://example.test/A.png");
    await userEvent.click(within(preview).getByRole("button", { name: "放大" }));
    expect(within(preview).getByText("125%")).toBeTruthy();
    await userEvent.click(within(preview).getByRole("button", { name: "向右旋转" }));
    expect(within(preview).getByRole("img").style.transform).toContain("rotate(90deg)");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "A · J1" })).toBeNull();
    expect(screen.getByRole("region", { name: "接线任务" })).toBeTruthy();
  });
  it("shows errors and leaves confirmation available for a retry", async () => {
    const { card, completeTask } = setup();
    completeTask.mockRejectedValueOnce(new Error("connection lost"));
    render(card());
    await userEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "connection lost");
    expect(screen.getByRole("button", { name: "完成" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("WiringLogPanel", () => {
  it("keeps open requests on top and mixes AI guidance with manual edits in the history", async () => {
    const { panel, listTasks, listChanges, completeTask } = setup();
    listTasks.mockResolvedValue([baseTask, history]);
    listChanges.mockResolvedValue([manual]);
    render(panel());
    const open = within(await screen.findByRole("region", { name: "待处理" }));
    await userEvent.click(open.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith("task-1", "confirmed"));
    const past = within(screen.getByRole("region", { name: "历史记录" }));
    expect(await past.findByText(/删除接线 A J1 ↔ B J1/)).toBeTruthy();
    const ai = past.getByRole("button", { name: /连接 A J1 → B J1/ });
    await userEvent.click(ai);
    expect(ai.getAttribute("aria-expanded")).toBe("true");
    expect(past.getByRole("region", { name: "接线任务" })).toBeTruthy();
    await userEvent.click(past.getByRole("button", { name: "人工更改" }));
    expect(past.queryByRole("button", { name: /连接 A J1 → B J1/ })).toBeNull();
    expect(past.getByText(/删除接线/)).toBeTruthy();
  });
});

describe("extractTask", () => {
  it("reads the task from every shape OpenCode hands over", () => {
    const json = JSON.stringify(baseTask);
    expect(extractTask(baseTask)?.wiringTaskId).toBe("task-1");
    expect(extractTask(json)?.wiringTaskId).toBe("task-1");
    expect(extractTask({ data: baseTask })?.wiringTaskId).toBe("task-1");
    expect(extractTask({ content: [{ type: "text", text: json }] })?.wiringTaskId).toBe("task-1");
    expect(extractTask("not json")).toBeUndefined();
  });
});
