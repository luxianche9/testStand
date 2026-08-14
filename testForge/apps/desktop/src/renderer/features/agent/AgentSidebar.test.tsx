// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OpenCodeRuntimeStatus } from "@testforge/contracts/agents";
import type { TestForgeApi } from "@testforge/contracts/desktop";
import type { LlmSettings } from "@testforge/contracts/storage";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-dom";
import { AssistantSidebar } from "./AgentSidebar";

const status = (state: OpenCodeRuntimeStatus["state"], message?: string): OpenCodeRuntimeStatus => ({
  state,
  workspaceState: "requires_project",
  version: "1.18.15",
  ...(message ? { message } : {})
});

function installApi(currentStatus: OpenCodeRuntimeStatus, settings: LlmSettings) {
  const saveLlmSettings = vi.fn(async (input: { baseUrl: string; model: string; clearApiKey?: boolean }) => ({
    baseUrl: input.baseUrl,
    model: input.model,
    apiKeyConfigured: !input.clearApiKey
  }));
  const api = {
    agents: {
      openCodeStatus: vi.fn(async () => currentStatus),
      startOpenCode: vi.fn(async () => status("running")),
      stopOpenCode: vi.fn(async () => status("stopped")),
      restartOpenCode: vi.fn(async () => status("running"))
    },
    settings: { getLlm: vi.fn(async () => settings), saveLlm: saveLlmSettings },
    events: { subscribe: vi.fn(() => () => undefined) }
  } as unknown as TestForgeApi;
  Object.defineProperty(window, "testforge", { configurable: true, value: api });
  return { api, saveLlmSettings };
}

function renderSidebar(onOpenSettings = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AssistantSidebar gatewayRunning onClose={() => undefined} onOpenSettings={onOpenSettings} /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AssistantSidebar runtime states", () => {
  it.each([
    [status("stopped"), { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKeyConfigured: false }, "先完成模型配置"],
    [status("starting"), { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKeyConfigured: true }, "正在启动 OpenCode"],
    [status("stopped"), { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKeyConfigured: true }, "OpenCode 已停止"],
    [status("error", "认证失败"), { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKeyConfigured: true }, "OpenCode 启动失败"]
  ])("renders the expected state for %s", async (runtimeStatus, settings, title) => {
    installApi(runtimeStatus, settings);
    renderSidebar();
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    if (runtimeStatus.state === "error") expect(screen.getByText("认证失败")).toBeTruthy();
  });

  it("keeps configuration out of the sidebar and routes users to settings", async () => {
    installApi(status("stopped"), { baseUrl: "https://old.example/v1", model: "old-model", apiKeyConfigured: true });
    const onOpenSettings = vi.fn();
    renderSidebar(onOpenSettings);
    expect(screen.queryByRole("button", { name: "打开模型设置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "启动助手" })).toBeNull();
    (await screen.findByRole("button", { name: "打开设置" })).click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
