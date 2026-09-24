// @vitest-environment jsdom

import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type RemoteThreadListAdapter,
  useLocalRuntime,
  useRemoteThreadListRuntime
} from "@assistant-ui/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-dom";
import { ThreadList } from "./ThreadList";

const modelAdapter: ChatModelAdapter = { async *run() {} };

function createThreadListAdapter(initialize: RemoteThreadListAdapter["initialize"]): RemoteThreadListAdapter {
  return {
    list: async () => ({ threads: [] }),
    initialize,
    rename: async () => undefined,
    archive: async () => undefined,
    unarchive: async () => undefined,
    delete: async () => undefined,
    generateTitle: async () => new ReadableStream({ start: (controller) => controller.close() }) as never,
    fetch: async (id) => ({ status: "regular", remoteId: id, externalId: id, title: "测试会话" })
  };
}

function useRuntimeHook() {
  return useLocalRuntime(modelAdapter);
}

function Runtime({ adapter, onCreated }: { adapter: RemoteThreadListAdapter; onCreated: () => void }) {
  const runtime = useRemoteThreadListRuntime({
    adapter,
    runtimeHook: useRuntimeHook
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadList onThreadSelected={onCreated} />
    </AssistantRuntimeProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OpenCode thread creation", () => {
  it("initializes the remote session before closing the thread drawer", async () => {
    const initialize = vi.fn(async () => ({ remoteId: "session-1", externalId: "session-1" }));
    const onCreated = vi.fn();
    render(<Runtime adapter={createThreadListAdapter(initialize)} onCreated={onCreated} />);

    await userEvent.click(await screen.findByRole("button", { name: "新建对话" }));

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(initialize.mock.invocationCallOrder[0]!).toBeLessThan(onCreated.mock.invocationCallOrder[0]!);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
