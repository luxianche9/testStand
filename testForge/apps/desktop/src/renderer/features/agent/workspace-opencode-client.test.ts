import type { OpencodeClient, Session } from "@assistant-ui/react-opencode";
import { describe, expect, it, vi } from "vitest";
import {
  persistWorkspaceThread,
  resolveWorkspaceThread,
  scopeOpencodeClient,
  workspaceThreadStorageKey
} from "./workspace-opencode-client";

function storageFixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    values
  };
}

function session(id: string, directory: string, updated: number): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory,
    title: id,
    version: "1.18.15",
    time: { created: updated - 1, updated }
  };
}

describe("scopeOpencodeClient", () => {
  it("injects the workspace into all Agent API namespaces without dropping inputs", async () => {
    const calls = {
      list: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      event: vi.fn(),
      permission: vi.fn(),
      question: vi.fn(),
      file: vi.fn(),
      v2: vi.fn()
    };
    const raw = {
      session: { create: calls.create, get: calls.get, promptAsync: calls.prompt, abort: calls.abort },
      experimental: { session: { list: calls.list } },
      event: { subscribe: calls.event },
      permission: { list: calls.permission },
      question: { list: calls.question },
      file: { read: calls.file },
      v2: { fs: { find: calls.v2 } }
    } as unknown as OpencodeClient;
    const client = scopeOpencodeClient(raw, "E:\\Project\\demo");
    const requestOptions = { throwOnError: true } as const;

    await client.experimental.session.list({ roots: true });
    await client.session.create({ title: "Demo" });
    await client.session.get({ sessionID: "ses_1" }, requestOptions);
    await client.session.promptAsync({ sessionID: "ses_1", parts: [] });
    await client.session.abort({ sessionID: "ses_1" });
    await client.event.subscribe();
    await client.permission.list();
    await client.question.list();
    await client.file.read({ path: "README.md" });
    await client.v2.fs.find({ query: "main", type: "file" });

    expect(calls.list).toHaveBeenCalledWith({ roots: true, directory: "E:\\Project\\demo" });
    expect(calls.create).toHaveBeenCalledWith({ title: "Demo", directory: "E:\\Project\\demo" });
    expect(calls.get).toHaveBeenCalledWith({ sessionID: "ses_1", directory: "E:\\Project\\demo" }, requestOptions);
    expect(calls.prompt).toHaveBeenCalledWith({ sessionID: "ses_1", parts: [], directory: "E:\\Project\\demo" });
    expect(calls.abort).toHaveBeenCalledWith({ sessionID: "ses_1", directory: "E:\\Project\\demo" });
    expect(calls.event).toHaveBeenCalledWith({ directory: "E:\\Project\\demo" });
    expect(calls.permission).toHaveBeenCalledWith({ directory: "E:\\Project\\demo" });
    expect(calls.question).toHaveBeenCalledWith({ directory: "E:\\Project\\demo" });
    expect(calls.file).toHaveBeenCalledWith({ path: "README.md", directory: "E:\\Project\\demo" });
    expect(calls.v2).toHaveBeenCalledWith({ query: "main", type: "file", directory: "E:\\Project\\demo" });
  });
});

describe("resolveWorkspaceThread", () => {
  it("restores a valid persisted session for the same workspace", async () => {
    const workspace = "E:\\Project\\Demo";
    const key = workspaceThreadStorageKey(workspace);
    const storage = storageFixture({ [key]: "ses_saved" });
    const get = vi.fn(async () => ({ data: session("ses_saved", "e:/project/demo/", 10) }));
    const list = vi.fn();
    const client = { session: { get }, experimental: { session: { list } } } as unknown as OpencodeClient;

    await expect(resolveWorkspaceThread(client, workspace, storage)).resolves.toBe("ses_saved");
    expect(list).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("clears a stale session, filters other workspaces and selects the newest current session", async () => {
    const workspace = "E:\\Project\\Demo";
    const key = workspaceThreadStorageKey(workspace);
    const storage = storageFixture({ [key]: "ses_stale" });
    const get = vi.fn(async () => ({ data: session("ses_stale", "E:\\Project\\Other", 99) }));
    const list = vi.fn(async () => ({ data: [
      session("ses_other", "E:\\Project\\Other", 200),
      session("ses_old", workspace, 100),
      session("ses_new", "e:/project/demo", 150)
    ] }));
    const client = { session: { get }, experimental: { session: { list } } } as unknown as OpencodeClient;

    await expect(resolveWorkspaceThread(client, workspace, storage)).resolves.toBe("ses_new");
    expect(storage.removeItem).toHaveBeenCalledWith(key);
    expect(storage.values.get(key)).toBe("ses_new");
    expect(list).toHaveBeenCalledWith(
      { roots: true, archived: false, limit: 100 },
      { throwOnError: true }
    );
  });

  it("persists only settled remote thread IDs per workspace", () => {
    const storage = storageFixture();
    persistWorkspaceThread(storage, "E:\\Project\\Demo", "ses_1");
    persistWorkspaceThread(storage, "E:\\Project\\Demo", "");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.values.get(workspaceThreadStorageKey("e:/project/demo/"))).toBe("ses_1");
  });
});
