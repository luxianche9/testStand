// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";
import { displayableImage, ManualCheckDialog } from "./ManualCheckDialog.js";
import { installTestingApi, makePlan, makeRun } from "./testing-api.fixture.js";

const plan = makePlan();
let api: ReturnType<typeof installTestingApi>;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

const request = {
  executionId: "exec-1", stepId: "look", name: "看彩条", prompt: "屏幕是否显示彩条？",
  images: ["https://example.test/bars.png", "images/bars.png"],
  options: [
    { label: "通过", verdict: "pass" as const },
    { label: "不通过", verdict: "fail" as const },
    { label: "无法判断", verdict: "inconclusive" as const }
  ],
  requireNote: true, requestedAt: "2026-10-01T00:00:00Z"
};

beforeEach(() => {
  localStorage.clear();
  api = installTestingApi([plan]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ManualCheckDialog", () => {
  it("stays hidden while nothing waits for the operator", async () => {
    api.testing.currentRun.mockResolvedValue(makeRun(plan, { runId: "run-1", manualChecks: [] }));
    render(<ManualCheckDialog />, { wrapper: Wrapper });
    await waitFor(() => expect(api.testing.currentRun).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requires the note before an answer and sends the chosen option with the operator", async () => {
    api.testing.currentRun.mockResolvedValue(makeRun(plan, { runId: "run-1", manualChecks: [request] }));
    render(<ManualCheckDialog />, { wrapper: Wrapper });
    expect(await screen.findByText("屏幕是否显示彩条？")).toBeTruthy();
    expect(screen.getByRole("img", { name: "参考图片" })).toBeTruthy();
    expect(screen.getByText("images/bars.png")).toBeTruthy();
    const fail = screen.getByRole("button", { name: "不通过" });
    expect(fail.hasAttribute("disabled")).toBe(true);

    await userEvent.type(screen.getByRole("textbox", { name: "判定说明" }), "没有彩条");
    await userEvent.type(screen.getByRole("textbox", { name: "判定人" }), "张工");
    await userEvent.click(fail);
    await waitFor(() => expect(api.testing.answerManualCheck).toHaveBeenCalledWith({
      input: { runId: "run-1", executionId: "exec-1", option: "不通过", note: "没有彩条", operator: "张工" }
    }));
    expect(localStorage.getItem("teststand.manualCheck.operator")).toBe("张工");
  });

  it("shows only images the renderer can load by itself", () => {
    expect(displayableImage("data:image/png;base64,AAAA")).toBe(true);
    expect(displayableImage("https://example.test/a.png")).toBe(true);
    expect(displayableImage("C:/images/a.png")).toBe(false);
  });
});
