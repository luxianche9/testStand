// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";
import { installTestingApi, makePlan } from "../testing/testing-api.fixture.js";
import { IcdEditorDialog } from "./IcdEditorDialog.js";
import { newIcdDoc } from "./icd-document.js";

let api: ReturnType<typeof installTestingApi>;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

const VALID = {
  valid: true,
  icd: { name: "dut", icdHash: "h", transport: "bytes" as const, messages: ["status"], encoders: [], streams: [] }
};

beforeEach(() => {
  api = installTestingApi([makePlan()]);
  api.testing.listIcds.mockResolvedValue([
    { name: "dut_ack", file: "icd/dut_ack.icd.yaml", valid: true },
    { name: "broken", file: "icd/broken.icd.yaml", valid: false, error: "bad" }
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IcdEditorDialog", () => {
  it("opens a file the table cannot show as YAML, decodes samples against it and saves the text", async () => {
    api.testing.readIcd.mockResolvedValue({ name: "dut_ack", text: "name: dut_ack\n", valid: true });
    api.testing.checkIcd.mockResolvedValue({
      ...VALID,
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
    expect(result.textContent).toContain("校验失败");
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
    const result = await screen.findByRole("region", { name: "检查结果" });
    await waitFor(() => expect(result.textContent).toContain("/framing：unknown kind"));
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns bytes picked in a captured frame into a field and saves the table as a document", async () => {
    const status = { name: "status", match: [{ offset: 3, value: 1 }], fields: [] };
    const document = { ...newIcdDoc("dut"), messages: [status] };
    api.testing.readIcd.mockResolvedValue({ name: "dut", text: "name: dut\n", valid: true });
    api.testing.icdDocument.mockResolvedValue({ valid: true, document, algorithms: ["sum8", "crc16_modbus"] });
    api.testing.checkIcd.mockResolvedValue({
      ...VALID, decoded: { "dut.status": [{ t: 0, seq: 0, fields: {}, raw: "aa5505010009e2" }] }
    });
    const recent = vi.fn(async () => ({
      key: "COM__link", type: "bytes",
      records: [{ t: 1, tb: 1, dir: "rx", data: "aa5505010009e2" }, { t: 2, tb: 2, dir: "tx", data: "ff" }]
    }));
    Object.assign(window.teststand, { streams: { recent } });
    const source = { hardwareId: "COM", streamId: "link" };
    render(<IcdEditorDialog name="dut" alias="dut" source={source} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(await screen.findByRole("textbox", { name: "协议名" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /抓取最近报文/ }));
    expect(recent).toHaveBeenCalledWith({ key: "COM__link", limit: 200 });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "试解码样本" }) as HTMLTextAreaElement).value)
      .toBe("AA 55 05 01 00 09 E2"));
    await userEvent.click(await screen.findByRole("listitem"));
    const grid = await screen.findByRole("grid", { name: "帧字节" });
    fireEvent.mouseDown(within(grid).getByRole("gridcell", { name: "第 5 字节 09" }));
    fireEvent.mouseEnter(within(grid).getByRole("gridcell", { name: "第 6 字节 E2" }));
    fireEvent.mouseUp(grid);
    const picked = await screen.findByLabelText("所选字节");
    expect(picked.textContent).toContain("无符号 大端 2530");
    fireEvent.change(screen.getByRole("textbox", { name: "新字段名" }), { target: { value: "temp" } });
    await userEvent.click(screen.getByRole("button", { name: "定义为字段" }));
    expect(await screen.findByRole("row", { name: "字段 temp" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.testing.saveIcd).toHaveBeenCalled());
    const saved = api.testing.saveIcd.mock.calls[0]?.[0].input;
    expect(saved?.name).toBe("dut");
    expect((saved?.document as { messages: { fields: unknown[] }[] }).messages[0]?.fields).toEqual([
      { name: "temp", offset: 5, type: "u16", endian: "big" }
    ]);
  });

  it("switches to YAML through the backend and refuses to switch while the table is wrong", async () => {
    api.testing.checkIcd.mockResolvedValue(VALID);
    render(<IcdEditorDialog onClose={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.change(await screen.findByRole("textbox", { name: "协议名" }), { target: { value: "riu" } });
    api.testing.renderIcd.mockResolvedValueOnce({ valid: false, error: "messages.0.fields.0: bad" });
    await userEvent.click(screen.getByRole("button", { name: "YAML" }));
    expect(await screen.findByText(/先改正再切换/)).toBeTruthy();
    api.testing.renderIcd.mockResolvedValueOnce({ valid: true, text: "name: riu\n" });
    await userEvent.click(screen.getByRole("button", { name: "YAML" }));
    const text = await screen.findByRole("textbox", { name: "ICD 内容" });
    expect((text as HTMLTextAreaElement).value).toBe("name: riu\n");
    expect(api.testing.renderIcd).toHaveBeenLastCalledWith({
      input: { document: expect.objectContaining({ name: "riu" }) }
    });
  });
});
