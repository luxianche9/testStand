import {
  createOpencodeClient,
  type OpencodeClient,
  type Session
} from "@assistant-ui/react-opencode";

const SCOPED_NAMESPACES = new Set([
  "session",
  "experimental",
  "event",
  "permission",
  "question",
  "file",
  "v2"
]);

const THREAD_STORAGE_PREFIX = "testforge.opencode-thread";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeApiNamespace<T extends object>(target: T, directory: string, cache: WeakMap<object, object>): T {
  const cached = cache.get(target);
  if (cached) return cached as T;

  const proxy = new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const [input, ...rest] = args;
          const scopedInput = isRecord(input) ? { ...input, directory } : { directory };
          return Reflect.apply(value, current, [scopedInput, ...rest]);
        };
      }
      return isRecord(value) ? scopeApiNamespace(value, directory, cache) : value;
    }
  });
  cache.set(target, proxy);
  return proxy;
}

export function scopeOpencodeClient(client: OpencodeClient, directory: string): OpencodeClient {
  if (!directory.trim()) throw new Error("OpenCode 工作区目录不能为空");
  const cache = new WeakMap<object, object>();
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !SCOPED_NAMESPACES.has(property) || !isRecord(value)) return value;
      return scopeApiNamespace(value, directory, cache);
    }
  });
}

export function createWorkspaceOpencodeClient(baseUrl: string, directory: string): OpencodeClient {
  return scopeOpencodeClient(createOpencodeClient({ baseUrl }), directory);
}

function normalizeWorkspacePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase("en-US");
}

function isSessionInWorkspace(session: Pick<Session, "directory">, workspace: string): boolean {
  return normalizeWorkspacePath(session.directory) === normalizeWorkspacePath(workspace);
}

export function workspaceThreadStorageKey(workspace: string): string {
  return `${THREAD_STORAGE_PREFIX}:${encodeURIComponent(normalizeWorkspacePath(workspace))}`;
}

export function persistWorkspaceThread(storage: StorageLike, workspace: string, threadId: string): void {
  if (threadId) storage.setItem(workspaceThreadStorageKey(workspace), threadId);
}

export async function resolveWorkspaceThread(
  client: OpencodeClient,
  workspace: string,
  storage: StorageLike
): Promise<string | undefined> {
  const storageKey = workspaceThreadStorageKey(workspace);
  const persistedId = storage.getItem(storageKey);

  if (persistedId) {
    try {
      const response = await client.session.get({ sessionID: persistedId }, { throwOnError: true });
      if (response.data?.id === persistedId && isSessionInWorkspace(response.data, workspace)) return persistedId;
    } catch {
      // A moved/deleted session is recovered through the workspace list below.
    }
    storage.removeItem(storageKey);
  }

  const response = await client.experimental.session.list(
    { roots: true, archived: false, limit: 100 },
    { throwOnError: true }
  );
  const newest = (response.data ?? [])
    .filter((session) => !session.parentID && typeof session.time.archived !== "number" && isSessionInWorkspace(session, workspace))
    .sort((left, right) => right.time.updated - left.time.updated)[0];

  if (newest) storage.setItem(storageKey, newest.id);
  return newest?.id;
}
