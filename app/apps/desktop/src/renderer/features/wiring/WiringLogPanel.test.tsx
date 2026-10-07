// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Hardware } from "@teststand/contracts/devices";
import type { TestStandApi } from "@teststand/contracts/desktop";
import type { WiringChange, WiringTask } from "@teststand/contracts/wiring";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-dom";
import { WiringLogPanel } from "./WiringLogPanel";
import { WiringTaskCard } from "./WiringTaskCard";
import { extractTask, taskForRequest } from "./wiring-model";

const hardware: Hardware[] = ["A", "B", "C"].map((hardwareId) => ({
  formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
  ports: [{ portId: "J1", name: "J1", pins: [{ pinId: "1", position: 1, label: "PIN 1" }] }], signals: []
}));
const baseTask: WiringTask = {
  wiringTaskId: "task-1",
  changes: [
    { action: "connect", portA: "A.J1", portB: "B.J1", pins: [{ a: "1", b: "1" }] },
    { action: "disconnect", portA: "B.J1", portB: "C.J1", pins: [] }
  ],
  hardwareIds: ["A", "B", "C"], status: "pending", requestedBy: "agent", note: "第一轮测试",
  requestedAt: new Date().toISOString()
};
const manual: WiringChange = {
  entryId: "change-1", kind: "removed", connectionId: "c1", portA: "A.J1", portB: "B.J1",
  pins: [], at: "2026-01-03T00:00:00.000Z"
};
const fromAgent: WiringChange = {
  entryId: "change-2", kind: "added", connectionId: "c2", portA: "A.J1", portB: "C.J1",
  pins: [], wiringTaskId: "task-0", at: "2026-01-04T00:00:00.000Z"
};

function setup() {
  const completeTask = vi.fn(async () => ({ ...baseTask, status: "confirmed" as const }));
  const listChanges = vi.fn(async (): Promise<WiringChange[]> => []);
  Object.defineProperty(window, "teststand", { configurable: true, value: {
    wiring: { completeTask, listChanges }
  } as unknown as TestStandApi });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChanged = vi.fn(async () => undefined);
  const card = (task = baseTask) => (
    <QueryClientProvider client={client}>
      <WiringTaskCard task={task} hardware={hardware} onChanged={onChanged} />
    </QueryClientProvider>
  );
  const panel = () => <QueryClientProvider client={client}><WiringLogPanel hardware={hardware} /></QueryClientProvider>;
  return { completeTask, listChanges, onChanged, card, panel };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("WiringTaskCard", () => {
  it("lists every change of the batch and confirms them at once", async () => {
    const { card, completeTask, onChanged } = setup();
    render(card());
    const list = within(screen.getByRole("list", { name: "接线清单" }));
    expect(list.getAllByRole("listitem", { name: /连接|断开/ }).map((item) => item.getAttribute("aria-label")))
      .toEqual(["连接", "断开"]);
    expect(screen.getByText("第一轮测试")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "已全部完成" }));
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith({ taskId: "task-1", outcome: "confirmed" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });
  it("rejects with the operator's reason", async () => {
    const { card, completeTask } = setup();
    render(card());
    await userEvent.click(screen.getByRole("button", { name: "未完成" }));
    await userEvent.type(screen.getByRole("textbox", { name: "未完成原因" }), "缺少线缆");
    await userEvent.click(screen.getByRole("button", { name: "提交未完成" }));
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith({
      taskId: "task-1", outcome: "rejected", message: "缺少线缆"
    }));
  });
  it.each(["confirmed", "cancelled", "failed", "rejected"] as const)("shows %s read-only", (status) => {
    const { card } = setup();
    render(card({ ...baseTask, status }));
    expect(screen.queryByRole("button", { name: "已全部完成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "未完成" })).toBeNull();
  });
  it("shows errors and leaves confirmation available for a retry", async () => {
    const { card, completeTask } = setup();
    completeTask.mockRejectedValueOnce(new Error("connection lost"));
    render(card());
    await userEvent.click(screen.getByRole("button", { name: "已全部完成" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "connection lost");
    expect(screen.getByRole("button", { name: "已全部完成" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("WiringLogPanel", () => {
  it("lists only changes and tells AI wiring from manual edits", async () => {
    const { panel, listChanges } = setup();
    listChanges.mockResolvedValue([manual, fromAgent]);
    render(panel());
    const log = within(await screen.findByRole("region", { name: "变更记录" }));
    expect(await log.findByText(/删除接线 A J1 ↔ B J1/)).toBeTruthy();
    expect(log.getByText(/新增接线 A J1 ↔ C J1/)).toBeTruthy();
    expect(log.getByLabelText("AI 接线")).toBeTruthy();
    await userEvent.click(log.getByRole("button", { name: "人工更改" }));
    expect(log.queryByText(/新增接线/)).toBeNull();
    expect(log.getByText(/删除接线/)).toBeTruthy();
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

describe("taskForRequest", () => {
  it("finds the open task a waiting call made from its arguments", () => {
    const done = { ...baseTask, wiringTaskId: "task-0", status: "confirmed" as const };
    const tasks = [done, baseTask];
    expect(taskForRequest(tasks, { changes: [{ action: "connect", portA: "B.J1", portB: "A.J1" }] })?.wiringTaskId)
      .toBe("task-1");
    expect(taskForRequest(tasks, { action: "connect", portA: "A.J1", portB: "B.J1" })?.wiringTaskId).toBe("task-1");
    expect(taskForRequest(tasks, { changes: [{ action: "connect", portA: "A.J1", portB: "C.J1" }] })).toBeUndefined();
  });
});
