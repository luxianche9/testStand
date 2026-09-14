// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { WiringTask } from "@hardwareharness/contracts/wiring";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-dom";
import { WiringTaskModal } from "./WiringTaskPanel";

const hardware: Hardware[] = ["A", "B"].map((hardwareId) => ({
  formatVersion: 2,
  hardwareId,
  label: hardwareId,
  kind: "passive",
  ports: [{ portId: "J1", name: "J1", pins: [{ pinId: "1", position: 1, label: "PIN 1" }] }]
}));

const baseTask: WiringTask = {
  wiringTaskId: "task-1",
  action: "connect",
  portA: "A.J1",
  portB: "B.J1",
  pins: [{ a: "1", b: "1" }],
  hardwareIds: ["A", "B"],
  status: "pending",
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  warnings: []
};

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

describe("WiringTaskModal", () => {
  it("starts a pending task and then allows the operator to confirm it", async () => {
    const startTask = vi.fn(async () => ({ ...baseTask, status: "in_progress" as const }));
    const completeTask = vi.fn(async () => ({ ...baseTask, status: "confirmed" as const }));
    Object.defineProperty(window, "hardwareharness", {
      configurable: true,
      value: { wiring: { startTask, completeTask } } as unknown as HardwareHarnessApi
    });
    const onChanged = vi.fn(async () => undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <WiringTaskModal task={baseTask} hardware={hardware} assetUrls={{}} onAssetUrl={() => undefined} onChanged={onChanged} />
      </QueryClientProvider>
    );

    const startButton = screen.getByRole("button", { name: "开始处理" });
    expect(startButton.hasAttribute("disabled")).toBe(false);
    await userEvent.click(startButton);
    await waitFor(() => expect(startTask).toHaveBeenCalledWith("task-1", "operator"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());

    view.rerender(
      <QueryClientProvider client={client}>
        <WiringTaskModal task={{ ...baseTask, status: "in_progress", startedAt: new Date().toISOString() }} hardware={hardware} assetUrls={{}} onAssetUrl={() => undefined} onChanged={onChanged} />
      </QueryClientProvider>
    );
    const confirmButton = screen.getByRole("button", { name: "已完成" });
    expect(confirmButton.hasAttribute("disabled")).toBe(false);
    await userEvent.click(confirmButton);
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith("task-1", "confirmed"));
  });
});
