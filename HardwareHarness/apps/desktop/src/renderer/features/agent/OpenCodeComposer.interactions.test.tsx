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
  directory: "E:/Project/hardwareHarness",
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

function Harness({ client, onSelectionChange, onError, adapter = modelAdapter }: {
  client: OpencodeClient;
  onSelectionChange: (selection: OpenCodeSelection) => void;
  onError: (reason: unknown) => void;
  adapter?: ChatModelAdapter;
}) {
  const runtime = useLocalRuntime(adapter, { adapters: { attachments: attachmentAdapter } });
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
  it("sends ordinary text with Enter and cancels the active run through the real composer", async () => {
    const started = vi.fn<(options: Parameters<ChatModelAdapter["run"]>[0]) => void>();
    const aborted = vi.fn();
    const adapter: ChatModelAdapter = {
      async *run(options) {
        started(options);
        const cancellation = new Promise<void>((resolve) => {
          const finish = () => { aborted(); resolve(); };
          if (options.abortSignal.aborted) finish();
          else options.abortSignal.addEventListener("abort", finish, { once: true });
        });
        yield { content: [{ type: "text", text: "Working on the request" }] };
        await cancellation;
      }
    };
    const client = createClient();
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<Harness client={client} adapter={adapter} onSelectionChange={() => undefined} onError={onError} />);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(true);
    await user.type(input, "Check the input");
    await user.keyboard("{Shift>}{Enter}{/Shift}then wait");
    expect(input.value).toBe("Check the input\nthen wait");
    expect(started).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");

    const cancel = await screen.findByRole("button", { name: "停止生成" });
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    const request = started.mock.calls[0]![0];
    expect(request.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Check the input\nthen wait" }]
    });
    expect(request.abortSignal.aborted).toBe(false);
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: "发送消息" })).toBeNull();
    expect(screen.getByText("OpenCode 正在执行")).toBeTruthy();
    await user.click(cancel);

    await waitFor(() => expect(request.abortSignal.aborted).toBe(true));
    expect(aborted).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(true);
    await user.type(input, "Next request");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(false);
    expect(started).toHaveBeenCalledOnce();
    expect(client.session.command).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

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
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: { providerID: "anthropic", modelID: "claude-sonnet" } })
    );

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
    await waitFor(() => expect(client.v2.fs.find).toHaveBeenCalledWith(
      { query: "answer", type: "file", limit: "20" },
      { throwOnError: true }
    ));
    await userEvent.click(await screen.findByRole("button", { name: /src\/answer\.ts/i }));

    expect(await screen.findByText("src/answer.ts")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "移除 src/answer.ts" }));
    await waitFor(() => expect(screen.queryByText("src/answer.ts")).toBeNull());
    expect(onError).not.toHaveBeenCalled();
  });
});
