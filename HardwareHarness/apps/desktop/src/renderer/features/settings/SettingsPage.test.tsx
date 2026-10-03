// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import type { AgentIntegrationStatus } from "@hardwareharness/contracts/agents";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { DashboardSnapshot } from "@hardwareharness/contracts/operations";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui";
import { SettingsPage } from "./SettingsPage";

const endpoint = "http://127.0.0.1:47831/mcp";
const codex: AgentIntegrationStatus = {
  agent: "codex",
  state: "not_installed",
  gateway: { running: true, endpoint, toolCount: 3 },
  cli: { available: true, version: "0.40.0" },
  environment: { name: "HARDWAREHARNESS_MCP_TOKEN", state: "missing" },
  configuration: { state: "missing" }
};

function setup() {
  const api = {
    settings: {
      getLlm: vi.fn(async () => ({ baseUrl: "https://llm.example/v1", model: "gpt-x", apiKeyConfigured: true })),
      saveLlm: vi.fn(async (input: { baseUrl: string; model: string }) => ({ ...input, apiKeyConfigured: true }))
    },
    agents: {
      openCodeStatus: vi.fn(async () => ({ state: "running", workspaceState: "ready", version: "1.2.3" })),
      status: vi.fn(async () => codex),
      listTools: vi.fn(async () => []),
      preview: vi.fn(),
      install: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(async () => ({ ...codex, message: "连接正常" })),
      rotateGatewayToken: vi.fn()
    },
    dialogs: { exportText: vi.fn() }
  };
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: api as unknown as HardwareHarnessApi
  });
  const dashboard = {
    data: { gateway: { running: true, endpoint, toolCount: 3 } },
    isError: false,
    refetch: vi.fn()
  } as unknown as UseQueryResult<DashboardSnapshot>;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onThemeChange = vi.fn(async () => undefined);
  const onBack = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SettingsPage dashboard={dashboard} theme="system" onThemeChange={onThemeChange} onBack={onBack} />
      </ToastProvider>
    </QueryClientProvider>
  );
  return { api, onThemeChange, onBack };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SettingsPage", () => {
  it("switches theme from the appearance section and navigates back", async () => {
    const { onThemeChange, onBack } = setup();
    expect(screen.getByRole("heading", { name: /外观/ })).toBeTruthy();
    const dark = screen.getByRole("button", { name: /深色 始终使用深色界面。/ });
    await userEvent.click(dark);
    expect(onThemeChange).toHaveBeenCalledWith("dark");
    expect(screen.queryAllByRole("button", { name: "设置" })).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("edits the model settings and shows a single OpenCode runtime", async () => {
    const { api } = setup();
    await userEvent.click(screen.getByRole("button", { name: /AI 模型/ }));
    expect(screen.getByRole("heading", { name: /AI 模型/ })).toBeTruthy();
    const baseUrl = screen.getByLabelText("Base URL");
    await waitFor(() => expect((baseUrl as HTMLInputElement).value).toBe("https://llm.example/v1"));
    expect(await screen.findAllByText("OpenCode", { exact: true })).toHaveLength(1);

    await userEvent.clear(screen.getByLabelText("模型 ID"));
    await userEvent.type(screen.getByLabelText("模型 ID"), "gpt-y");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.settings.saveLlm).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://llm.example/v1", model: "gpt-y", clearApiKey: false })
    ));
  });

  it("shows the gateway and Codex integration and runs a connection test", async () => {
    const { api } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Agent 接入/ }));
    expect(screen.getByRole("heading", { name: /Agent 接入/ })).toBeTruthy();
    expect(screen.getAllByText("MCP Gateway").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex", { exact: true }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "检测连接" }));
    await waitFor(() => expect(api.agents.test).toHaveBeenCalledWith({ agent: "codex" }));
    expect(await screen.findByText("连接正常")).toBeTruthy();
  });
});
