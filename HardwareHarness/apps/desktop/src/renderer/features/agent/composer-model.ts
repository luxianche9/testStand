import type { Attachment } from "@assistant-ui/react";
import { type OpencodeClient, type Session, useOpenCodeSession } from "@assistant-ui/react-opencode";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/errors.js";

export type OpenCodeModelOption = {
  providerID: string;
  modelID: string;
  name: string;
  providerName: string;
  context?: number;
};

export type OpenCodeAgentOption = {
  id: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
};

export type OpenCodeCommandOption = {
  name: string;
  description?: string;
};

export type OpenCodeFileOption = {
  path: string;
  type: "file" | "directory";
};

export type OpenCodeCatalog = {
  models: OpenCodeModelOption[];
  agents: OpenCodeAgentOption[];
  commands: OpenCodeCommandOption[];
  loading: boolean;
  error?: string | undefined;
};

export type OpenCodeSelection = {
  model: { providerID: string; modelID: string };
  agent?: string | undefined;
};

export const REQUEST_OPTIONS = { throwOnError: true } as const;
const RECENT_FILES_KEY = "hardwareharness.opencode-recent-files";
const MAX_RECENT_FILES = 8;

export function parseOpenCodeCommand(text: string, commands: readonly OpenCodeCommandOption[]) {
  const [head, ...tail] = text.trim().split(/\s+/);
  if (!head?.startsWith("/")) return undefined;
  const name = head.slice(1);
  if (!commands.some((command) => command.name === name)) return undefined;
  return { name, arguments: tail.join(" ") };
}

export function filterOpenCodeCommands(commands: readonly OpenCodeCommandOption[], query: string, limit = 12) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return commands.filter((item) => !normalized
    || item.name.toLocaleLowerCase("zh-CN").includes(normalized)
    || item.description?.toLocaleLowerCase("zh-CN").includes(normalized)).slice(0, limit);
}

export function serializeOpenCodeCommandAttachments(attachments: readonly Attachment[]) {
  return attachments.flatMap((attachment) => (attachment.content ?? []).flatMap((part) => {
    if (part.type === "image") {
      const mime = attachment.contentType ?? "image/png";
      return [{ type: "file" as const, mime, filename: attachment.name, url: part.image }];
    }
    if (part.type === "file" && part.sourceType !== "id") {
      const filename = part.filename ?? attachment.name;
      return [{ type: "file" as const, mime: part.mimeType, filename, url: part.data }];
    }
    return [];
  }));
}

export function useOpenCodeCatalog(client: OpencodeClient, fallbackModelID: string) {
  const [catalog, setCatalog] = useState<OpenCodeCatalog>({ models: [], agents: [], commands: [], loading: true });

  useEffect(() => {
    let active = true;
    setCatalog((current) => ({ ...current, loading: true, error: undefined }));
    void Promise.all([
      client.v2.model.list(undefined, REQUEST_OPTIONS),
      client.v2.provider.list(undefined, REQUEST_OPTIONS),
      client.v2.agent.list(undefined, REQUEST_OPTIONS),
      client.v2.command.list(undefined, REQUEST_OPTIONS)
    ]).then(([modelsResponse, providersResponse, agentsResponse, commandsResponse]) => {
      if (!active) return;
      const providers = providersResponse.data?.data ?? [];
      const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
      const models = (modelsResponse.data?.data ?? [])
        .filter((model) => model.enabled && model.status !== "deprecated")
        .map((model) => ({
          providerID: model.providerID,
          modelID: model.id,
          name: model.name,
          providerName: providerNames.get(model.providerID) ?? model.providerID,
          context: model.limit.context
        }))
        .sort((left, right) =>
          left.providerName.localeCompare(right.providerName) || left.name.localeCompare(right.name));
      const fallback = models.find((model) => model.modelID === fallbackModelID);
      if (fallback) models.unshift(...models.splice(models.indexOf(fallback), 1));
      setCatalog({
        models,
        agents: (agentsResponse.data?.data ?? []).filter((agent) => !agent.hidden),
        commands: commandsResponse.data?.data ?? [],
        loading: false
      });
    }).catch((reason) => {
      if (!active) return;
      setCatalog({ models: [], agents: [], commands: [], loading: false, error: errorMessage(reason) });
    });
    return () => { active = false; };
  }, [client, fallbackModelID]);

  return catalog;
}

export function readRecentFiles() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT_FILES);
  } catch {
    return [];
  }
}

export function recentFileOptions(): OpenCodeFileOption[] {
  return readRecentFiles().map((path) => ({ path, type: "file" }));
}

export function rememberFile(path: string) {
  const next = [path, ...readRecentFiles().filter((item) => item !== path)].slice(0, MAX_RECENT_FILES);
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
}

export function formatContext(value?: number) {
  if (!value) return undefined;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M ctx`;
  return `${Math.round(value / 1_000)}k ctx`;
}

function selectionFromSession(session: Session | null, fallback: OpenCodeSelection): OpenCodeSelection {
  const model = session?.model ? { providerID: session.model.providerID, modelID: session.model.id } : fallback.model;
  const agent = session?.agent ?? fallback.agent;
  return agent ? { model, agent } : { model };
}

export function useSessionSelection(fallback: OpenCodeSelection) {
  const session = useOpenCodeSession();
  const fallbackRef = useRef(fallback);
  useEffect(() => { fallbackRef.current = fallback; }, [fallback]);
  const [selection, setSelection] = useState<OpenCodeSelection>(() => selectionFromSession(session, fallback));

  useEffect(() => {
    setSelection(selectionFromSession(session, fallbackRef.current));
  }, [session]);

  return [selection, setSelection] as const;
}
