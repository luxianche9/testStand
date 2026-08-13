// @vitest-environment jsdom

import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  useLocalRuntime
} from "@assistant-ui/react";
import { OpenCodeAttachmentAdapter, type OpencodeClient, type Session } from "@assistant-ui/react-opencode";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-dom";
import {
  OpenCodeComposer,
  type OpenCodeCatalog,
  type OpenCodeSelection
} from "./OpenCodeComposer";

const modelAdapter: ChatModelAdapter = { async *run() {} };
const attachmentAdapter = new OpenCodeAttachmentAdapter();
const catalog: OpenCodeCatalog = {
  models: [
    { providerID: "openai", modelID: "gpt-4.1", name: "GPT 4.1", providerName: "OpenAI" },
    { providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet", providerName: "Anthropic" }
  ],
  agents: [
    { id: "build", description: "Build and edit", mode: "primary", hidden: false },
    { id: "plan", description: "Plan changes", mode: "all", hidden: false }
  ],
  commands: [{ name: "review", description: "Review current changes" }],
  loading: false
};
const session = {
  id: "session-1",
  slug: "session-1",
  projectID: "project-1",
  directory: "E:/Project/testForge",
  title: "Test",
  version: "1.18.15",
  time: { created: 1, updated: 1 }
} as Session;

function createClient() {
  return {
    session: { command: vi.fn(async () => ({ data: undefined })) },
    file: { read: vi.fn(async () => ({ data: { type: "text", content: "export const answer = 42;" } })) },
    v2: { fs: { find: vi.fn(async () => ({ data: { data: [{ path: "src/answer.ts", type: "file" }] } })) } }
  } as unknown as OpencodeClient;
}

function Harness({ client, onSelectionChange, onError }: { client: OpencodeClient; onSelectionChange: (selection: OpenCodeSelection) => void; onError: (reason: unknown) => void }) {
  const runtime = useLocalRuntime(modelAdapter, { adapters: { attachments: attachmentAdapter } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <OpenCodeComposer
        client={client}
        catalog={catalog}
        selection={{ model: { providerID: "openai", modelID: "gpt-4.1" }, agent: "build" }}
        onSelectionChange={onSelectionChange}
        attachmentAdapter={attachmentAdapter}
        attachmentAccept={attachmentAdapter.accept}
        clientSession={session}
        onError={onError}
      />
    </AssistantRuntimeProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("OpenCode composer interactions", () => {
  it("selects and dispatches a registered slash command through session.command", async () => {
    const client = createClient();
    render(<Harness client={client} onSelectionChange={() => undefined} onError={() => undefined} />);

    await userEvent.click(screen.getByRole("button", { name: "打开命令菜单" }));
    await userEvent.click(await screen.findByRole("button", { name: /review/i }));
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "src/app.ts");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(client.session.command).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: "session-1",
      command: "review",
      arguments: "src/app.ts",
      agent: "build",
      model: "openai/gpt-4.1"
    }), { throwOnError: true }));
    expect((screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("changes model and Agent selection", async () => {
    const onSelectionChange = vi.fn();
    render(<Harness client={createClient()} onSelectionChange={onSelectionChange} onError={() => undefined} />);

    await userEvent.click(screen.getByRole("button", { name: "选择模型" }));
    await userEvent.click(await screen.findByRole("button", { name: /Claude Sonnet/i }));
    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ model: { providerID: "anthropic", modelID: "claude-sonnet" } }));

    await userEvent.click(screen.getByRole("button", { name: "选择 Agent" }));
    await userEvent.click(await screen.findByRole("button", { name: /plan/i }));
    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ agent: "plan" }));
  });

  it("searches a project file, adds path-labelled context and removes it", async () => {
    const client = createClient();
    const onError = vi.fn();
    render(<Harness client={client} onSelectionChange={() => undefined} onError={onError} />);

    await userEvent.click(screen.getByRole("button", { name: "添加工程文件" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "搜索工程文件" }), "answer");
    await waitFor(() => expect(client.v2.fs.find).toHaveBeenCalledWith({ query: "answer", type: "file", limit: "20" }, { throwOnError: true }));
    await userEvent.click(await screen.findByRole("button", { name: /src\/answer\.ts/i }));

    expect(await screen.findByText("src/answer.ts")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "移除 src/answer.ts" }));
    await waitFor(() => expect(screen.queryByText("src/answer.ts")).toBeNull());
    expect(onError).not.toHaveBeenCalled();
  });
});
