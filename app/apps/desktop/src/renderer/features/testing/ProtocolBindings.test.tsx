// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";
import { IcdEditorDialog, ProtocolBindingsEditor } from "./ProtocolBindings.js";
import { installTestingApi, makePlan } from "./testing-api.fixture.js";

let api: ReturnType<typeof installTestingApi>;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

beforeEach(() => {
  api = installTestingApi([makePlan()], []);
  api.testing.listIcds.mockResolvedValue([
    { name: "dut_ack", file: "icd/dut_ack.icd.yaml", valid: true },
    { name: "broken", file: "icd/broken.icd.yaml", valid: false, error: "bad" }
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProtocolBindingsEditor", () => {
  it("adds a binding on the first valid ICD and reports duplicate aliases", async () => {
    const onChange = vi.fn();
    const source = { hardwareId: "dev", streamId: "uart" };
    const first = { icd: "dut_ack", alias: "dut", source };
    const { rerender } = render(<ProtocolBindingsEditor value={[first]} hardware={[]} onChange={onChange} />, {
      wrapper: Wrapper
    });
    expect(await screen.findByRole("option", { name: "broken（无效）" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "添加绑定" }));
    expect(onChange).toHaveBeenLastCalledWith([
      first, { icd: "dut_ack", alias: "dut_ack", source: { hardwareId: "", streamId: "" } }
    ]);
    rerender(
      <ProtocolBindingsEditor
        value={[{ icd: "dut_ack", alias: "dut", source }, { icd: "broken", alias: "dut", source }]}
        hardware={[]}
        onChange={onChange}
      />
    );
    expect(await screen.findAllByText("别名 dut 重复")).toHaveLength(2);
  });
});

describe("IcdEditorDialog", () => {
  it("trial-decodes samples against the edited text and saves it", async () => {
    api.testing.readIcd.mockResolvedValue({ name: "dut_ack", text: "name: dut_ack\n", valid: true });
    api.testing.checkIcd.mockResolvedValue({
      valid: true,
      icd: { name: "dut_ack", icdHash: "h", transport: "bytes", messages: ["ack"], encoders: [], streams: [] },
      decoded: { "dut.ack": [{ t: 0, fields: { code: 7 } }], "dut.$errors": [{ t: 0, reason: "checksum" }] }
    });
    const onClose = vi.fn();
    render(<IcdEditorDialog name="dut_ack" alias="dut" onClose={onClose} />, { wrapper: Wrapper });
    const editor = await screen.findByRole("textbox", { name: "ICD 内容" });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("name: dut_ack\n"));
    fireEvent.change(screen.getByRole("textbox", { name: "试解码样本" }), { target: { value: "AA 55\n01 07" } });
    await userEvent.click(screen.getByRole("button", { name: "检查并试解码" }));
    expect(api.testing.checkIcd).toHaveBeenCalledWith({
      input: { text: "name: dut_ack\n", alias: "dut", samples: ["AA55", "0107"] }
    });
    const result = await screen.findByRole("list", { name: "试解码结果" });
    expect(result.textContent).toContain("code=7");
    expect(result.textContent).toContain("checksum");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.testing.saveIcd).toHaveBeenCalledWith({
      input: { name: "dut_ack", text: "name: dut_ack\n" }
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows why an ICD is invalid and blocks saving it", async () => {
    api.testing.checkIcd.mockResolvedValue({
      valid: false, error: "ICD is invalid", issues: [{ path: "/framing", message: "unknown kind" }]
    });
    render(<IcdEditorDialog onClose={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.change(await screen.findByRole("textbox", { name: /文件名/ }), { target: { value: "new_icd" } });
    await userEvent.click(screen.getByRole("button", { name: "检查并试解码" }));
    const result = await screen.findByRole("region", { name: "检查结果" });
    expect(result.textContent).toContain("/framing：unknown kind");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
