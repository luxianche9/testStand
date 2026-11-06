// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";
import { installTestingApi, makePlan } from "../testing/testing-api.fixture.js";
import { BindProtocolDialog } from "./BindProtocolDialog.js";

let api: ReturnType<typeof installTestingApi>;
const update = vi.fn();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

beforeEach(() => {
  api = installTestingApi([makePlan()]);
  api.testing.listIcds.mockResolvedValue([
    { name: "can_db", file: "icd/can_db.icd.yaml", valid: true, transport: "frames" },
    { name: "dut_cmd", file: "icd/dut_cmd.icd.yaml", valid: true, transport: "bytes", description: "命令口" },
    { name: "broken", file: "icd/broken.icd.yaml", valid: false, error: "bad" }
  ]);
  update.mockResolvedValue([]);
  Object.assign(window.teststand, { protocols: { list: vi.fn(async () => []), update } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BindProtocolDialog", () => {
  it("offers the ICDs that decode the stream's type and binds one under a free alias", async () => {
    const onClose = vi.fn();
    render(
      <BindProtocolDialog hardwareId="COM" streamId="rx" streamType="bytes" aliases={["dut_cmd"]} onClose={onClose} />,
      { wrapper: Wrapper }
    );
    expect(await screen.findByRole("option", { name: "dut_cmd · 命令口" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /can_db/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /broken/ })).toBeNull();
    const alias = screen.getByRole("textbox", { name: "别名" }) as HTMLInputElement;
    expect(alias.value).toBe("dut_cmd2");
    await userEvent.click(screen.getByRole("button", { name: "绑定" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      input: {
        operations: [{ op: "add", icd: "dut_cmd", alias: "dut_cmd2", source: { hardwareId: "COM", streamId: "rx" } }]
      }
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("refuses an alias that is taken or not a name", async () => {
    render(
      <BindProtocolDialog hardwareId="COM" streamId="rx" streamType="bytes" aliases={["dut"]} onClose={vi.fn()} />,
      { wrapper: Wrapper }
    );
    await screen.findByRole("option", { name: "dut_cmd · 命令口" });
    const alias = screen.getByRole("textbox", { name: "别名" });
    fireEvent.change(alias, { target: { value: "dut" } });
    expect(screen.getByText("别名 dut 已被使用")).toBeTruthy();
    fireEvent.change(alias, { target: { value: "1x" } });
    expect(screen.getByText(/别名只能包含/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "绑定" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
