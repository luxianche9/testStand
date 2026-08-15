// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TestForgeApi } from "@testforge/contracts/desktop";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-dom";

const fixtures = vi.hoisted(() => {
  const initialize = vi.fn(async () => undefined);
  const switchToNewThread = vi.fn(async () => undefined);
  const client = {
    experimental: { session: { list: vi.fn(async () => ({ data: [] })) } },
    session: { get: vi.fn(), create: vi.fn() }
  };
  return {
    initialize,
    switchToNewThread,
    client,
    assistantState: {
      threads: { isLoading: false },
      threadListItem: { status: "new" }
    },
    threadState: {
      sessionId: "ses_test",
      runState: { type: "idle" as "idle" | "error", error: undefined as unknown }
    },
    runtimeOptions: undefined as undefined | { onThreadIdChange?: (threadId: string | undefined) => void }
  };
});

vi.mock("@assistant-ui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assistant-ui/react")>();
  const runtime = {
    threads: {
      switchToNewThread: fixtures.switchToNewThread,
      mainItem: {
        initialize: fixtures.initialize,
        getState: () => ({ status: "new" })
      }
    }
  };
  return {
    ...actual,
    AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
    useAui: () => ({
      dataRenderers: { setFallbackDataUI: vi.fn() },
      threads: { __internal_getAssistantRuntime: () => runtime }
    }),
    useAuiState: (selector: (state: typeof fixtures.assistantState) => unknown) => selector(fixtures.assistantState)
  };
});

vi.mock("@assistant-ui/react-opencode", () => ({
  OpenCodeAttachmentAdapter: class { accept = ""; },
  createOpencodeClient: () => fixtures.client,
  useOpenCodeRuntime: (options: { onThreadIdChange?: (threadId: string | undefined) => void }) => {
    fixtures.runtimeOptions = options;
    return {};
  },
  useOpenCodeSession: () => null,
  useOpenCodeThreadState: (selector?: (state: typeof fixtures.threadState) => unknown) => selector ? selector(fixtures.threadState) : fixtures.threadState
}));

vi.mock("./OpenCodeComposer", () => ({
  OpenCodeComposer: () => null,
  useOpenCodeCatalog: () => ({ models: [], agents: [], commands: [], loading: false }),
  useSessionSelection: (selection: unknown) => [selection, vi.fn()]
}));
vi.mock("./Thread", () => ({ Thread: () => <div data-testid="thread" /> }));
vi.mock("./ThreadList", () => ({ ThreadList: () => null }));
vi.mock("./OpenCodeDataPart", () => ({ OpenCodeDataPart: () => null }));
vi.mock("./OpenCodeGroups", () => ({ OpenCodeReasoningGroup: () => null, OpenCodeToolGroup: () => null }));
vi.mock("./tools/OpenCodeTools", () => ({ FallbackTool: () => null }));
vi.mock("./tools/toolkit", () => ({ OpenCodeToolUIs: () => null }));

import { AssistantSidebar } from "./AgentSidebar";
import { workspaceThreadStorageKey } from "./workspace-opencode-client";

function installApi() {
  const api = {
    agents: {
      openCodeStatus: vi.fn(async () => ({
        state: "running",
        workspaceState: "ready",
        version: "1.18.15",
        apiUrl: "http://127.0.0.1:4096",
        workspace: "E:\\Project\\demo"
      }))
    },
    settings: {
      getLlm: vi.fn(async () => ({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKeyConfigured: true }))
    },
    events: { subscribe: vi.fn(() => () => undefined) }
  } as unknown as TestForgeApi;
  Object.defineProperty(window, "testforge", { configurable: true, value: api });
}

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssistantSidebar gatewayRunning onClose={() => undefined} onOpenSettings={() => undefined} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  fixtures.initialize.mockClear();
  fixtures.switchToNewThread.mockClear();
  fixtures.client.experimental.session.list.mockClear();
  fixtures.threadState.runState = { type: "idle", error: undefined };
  installApi();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AssistantSidebar running session", () => {
  it("automatically initializes a new workspace session", async () => {
    renderSidebar();
    expect(await screen.findByTestId("thread")).toBeTruthy();
    expect(screen.getByLabelText("OpenCode 状态：已就绪")).toBeTruthy();
    await waitFor(() => expect(fixtures.initialize).toHaveBeenCalledOnce());
    expect(fixtures.client.experimental.session.list).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "E:\\Project\\demo" }),
      { throwOnError: true }
    );
    fixtures.runtimeOptions?.onThreadIdChange?.("ses_new");
    expect(localStorage.getItem(workspaceThreadStorageKey("E:\\Project\\demo"))).toBe("ses_new");
  });

  it("shows asynchronous server failures and offers a new conversation", async () => {
    fixtures.threadState.runState = { type: "error", error: new Error("workspace missing") };
    renderSidebar();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("workspace missing");
    within(alert).getByRole("button", { name: "新建对话" }).click();
    await waitFor(() => expect(fixtures.switchToNewThread).toHaveBeenCalledOnce());
  });
});
