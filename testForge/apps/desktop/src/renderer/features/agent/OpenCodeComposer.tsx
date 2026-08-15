import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  type Attachment,
  type PendingAttachment
} from "@assistant-ui/react";
import {
  type OpencodeClient,
  OpenCodeAttachmentAdapter,
  type Session,
  useOpenCodeSession,
  useOpenCodeThreadState
} from "@assistant-ui/react-opencode";
import { errorMessage } from "../../shared/errors.js";
import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  FileCodeIcon,
  Loader2Icon,
  PaperclipIcon,
  SearchIcon,
  SlashIcon,
  SquareIcon,
  TerminalIcon
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { ComposerAttachments } from "./Attachment";
import { Button, Input, TooltipIconButton } from "./ui";
import { cn } from "./utils";

type OpenCodeModelOption = {
  providerID: string;
  modelID: string;
  name: string;
  providerName: string;
  context?: number;
};

type OpenCodeAgentOption = {
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

export function parseOpenCodeCommand(text: string, commands: readonly OpenCodeCommandOption[]) {
  const [head, ...tail] = text.trim().split(/\s+/);
  if (!head?.startsWith("/")) return undefined;
  const name = head.slice(1);
  if (!commands.some((command) => command.name === name)) return undefined;
  return { name, arguments: tail.join(" ") };
}

export function filterOpenCodeCommands(commands: readonly OpenCodeCommandOption[], query: string, limit = 12) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return commands.filter((item) => !normalized || item.name.toLocaleLowerCase("zh-CN").includes(normalized) || item.description?.toLocaleLowerCase("zh-CN").includes(normalized)).slice(0, limit);
}

export function serializeOpenCodeCommandAttachments(attachments: readonly Attachment[]) {
  return attachments.flatMap((attachment) => (attachment.content ?? []).flatMap((part) => {
    if (part.type === "image") {
      return [{ type: "file" as const, mime: attachment.contentType ?? "image/png", filename: attachment.name, url: part.image }];
    }
    if (part.type === "file" && part.sourceType !== "id") {
      return [{ type: "file" as const, mime: part.mimeType, filename: part.filename ?? attachment.name, url: part.data }];
    }
    return [];
  }));
}

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

const REQUEST_OPTIONS = { throwOnError: true } as const;
const RECENT_FILES_KEY = "testforge.opencode-recent-files";
const MAX_RECENT_FILES = 8;

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
      const providerNames = new Map((providersResponse.data?.data ?? []).map((provider) => [provider.id, provider.name]));
      const models = (modelsResponse.data?.data ?? [])
        .filter((model) => model.enabled && model.status !== "deprecated")
        .map((model) => ({
          providerID: model.providerID,
          modelID: model.id,
          name: model.name,
          providerName: providerNames.get(model.providerID) ?? model.providerID,
          context: model.limit.context
        }))
        .sort((left, right) => left.providerName.localeCompare(right.providerName) || left.name.localeCompare(right.name));
      const fallback = models.find((model) => model.modelID === fallbackModelID);
      if (fallback) models.unshift(...models.splice(models.indexOf(fallback), 1));
      setCatalog({
        models,
        agents: (agentsResponse.data?.data ?? []).filter((agent) => !agent.hidden),
        commands: commandsResponse.data?.data ?? [],
        loading: false
      });
    }).catch((reason) => {
      if (active) setCatalog({ models: [], agents: [], commands: [], loading: false, error: errorMessage(reason) });
    });
    return () => { active = false; };
  }, [client, fallbackModelID]);

  return catalog;
}

function readRecentFiles() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT_FILES) : [];
  } catch {
    return [];
  }
}

function rememberFile(path: string) {
  const next = [path, ...readRecentFiles().filter((item) => item !== path)].slice(0, MAX_RECENT_FILES);
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
}

function formatContext(value?: number) {
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

export function OpenCodeComposer({
  client,
  catalog,
  selection,
  onSelectionChange,
  attachmentAdapter,
  attachmentAccept,
  clientSession,
  onError
}: {
  client: OpencodeClient;
  catalog: OpenCodeCatalog;
  selection: OpenCodeSelection;
  onSelectionChange: (selection: OpenCodeSelection) => void;
  attachmentAdapter: OpenCodeAttachmentAdapter;
  attachmentAccept: string;
  clientSession?: Session | null;
  onError: (reason: unknown) => void;
}) {
  const aui = useAui();
  const runtimeSession = useOpenCodeSession();
  const session = runtimeSession ?? clientSession;
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);
  const hasAttachments = useAuiState((state) => state.composer.attachments.length > 0);
  const commandReady = useAuiState((state) => Boolean(parseOpenCodeCommand(state.composer.text, catalog.commands)));
  const runState = useOpenCodeThreadState((state) => state.runState.type);
  const fileInput = useRef<HTMLInputElement>(null);
  const [picker, setPicker] = useState<"command" | "file" | null>(null);
  const [commandQuery, setCommandQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [files, setFiles] = useState<OpenCodeFileOption[]>(() => readRecentFiles().map((path) => ({ path, type: "file" })));
  const [filesLoading, setFilesLoading] = useState(false);

  const commands = useMemo(() => {
    return filterOpenCodeCommands(catalog.commands, commandQuery);
  }, [catalog.commands, commandQuery]);

  useEffect(() => {
    if (picker !== "file") return;
    const query = fileQuery.trim();
    if (!query) {
      setFiles(readRecentFiles().map((path) => ({ path, type: "file" })));
      setFilesLoading(false);
      return;
    }
    let active = true;
    setFilesLoading(true);
    const timer = window.setTimeout(() => {
      void client.v2.fs.find({ query, type: "file", limit: "20" }, REQUEST_OPTIONS).then((response) => {
        if (active) setFiles(response.data?.data ?? []);
      }).catch((reason) => {
        if (active) onError(reason);
      }).finally(() => {
        if (active) setFilesLoading(false);
      });
    }, 160);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, fileQuery, onError, picker]);

  const appendText = useCallback((text: string) => {
    const composer = aui.composer;
    const current = composer.getState().text;
    composer.setText(current ? `${current}${current.endsWith("\n") ? "" : "\n"}${text}` : text);
  }, [aui]);

  const commandFromText = useCallback((text: string) => {
    return parseOpenCodeCommand(text, catalog.commands);
  }, [catalog.commands]);

  const runCommand = useCallback(async () => {
    const composer = aui.composer;
    const state = composer.getState();
    const command = commandFromText(state.text);
    if (!command) return false;
    if (!session) throw new Error("OpenCode 会话尚未初始化");

    const attachments = await Promise.all(state.attachments.map(async (attachment) => {
      if (attachment.status.type === "complete") return attachment;
      if (attachment.status.type === "requires-action" && attachment.file) return attachmentAdapter.send(attachment as PendingAttachment);
      throw new Error("附件仍在处理中，请稍后重试");
    }));
    const parts = serializeOpenCodeCommandAttachments(attachments);
    if (parts.length !== attachments.length) throw new Error("自定义命令包含无法序列化的附件，请移除后重试");

    await client.session.command({
      sessionID: session.id,
      command: command.name,
      arguments: command.arguments,
      ...(selection.agent ? { agent: selection.agent } : {}),
      model: `${selection.model.providerID}/${selection.model.modelID}`,
      ...(parts.length > 0 ? { parts } : {})
    }, REQUEST_OPTIONS);
    await composer.reset();
    return true;
  }, [attachmentAdapter, aui, client, commandFromText, selection.agent, selection.model.modelID, selection.model.providerID, session]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    const command = commandFromText(aui.composer.getState().text);
    if (!command) return;
    event.preventDefault();
    void runCommand().catch(onError);
  }, [aui, commandFromText, onError, runCommand]);

  const attachWorkspaceFile = useCallback(async (file: OpenCodeFileOption) => {
    setPicker(null);
    setFileQuery("");
    if (file.type !== "file") return;
    try {
      const response = await client.file.read({ path: file.path }, REQUEST_OPTIONS);
      const content = response.data;
      if (!content || content.type !== "text") throw new Error("OpenCode 只能把可读文本文件作为上下文加入当前会话");
      const context = `Project file: ${file.path}\n\n${content.content}`;
      const blob = new File([context], file.path.replaceAll("\\", "/"), { type: "text/plain" });
      await aui.composer.addAttachment(blob);
      rememberFile(file.path);
    } catch (reason) {
      onError(reason);
    }
  }, [aui, client, onError]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const text = event.currentTarget.value;
    const cursor = event.currentTarget.selectionStart;
    if (event.key === "/" && cursor === 0 && !text) {
      event.preventDefault();
      setPicker("command");
      setCommandQuery("");
    } else if (event.key === "@" && (cursor === 0 || /\s/.test(text[cursor - 1] ?? ""))) {
      event.preventDefault();
      setPicker("file");
      setFileQuery("");
    } else if (event.key === "Escape") {
      setPicker(null);
    }
  };

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={handleSubmit}>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div className="flex w-full flex-col gap-2 rounded-xl border border-border/75 bg-(--composer-bg) p-2 shadow-[0_8px_28px_-18px_rgba(0,0,0,0.35),0_1px_2px_rgba(0,0,0,0.06)] transition-[border-color,box-shadow] focus-within:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-accent/50 dark:shadow-none">
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="输入任务，使用 @ 添加文件，使用 / 调用命令"
            className="max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/75"
            rows={1}
            autoFocus
            enterKeyHint="send"
            aria-label="消息"
            onKeyDown={handleInputKeyDown}
          />

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
            <div className="flex shrink-0 items-center gap-0.5">
              <input
                ref={fileInput}
                className="sr-only"
                type="file"
                multiple
                accept={attachmentAccept}
                onChange={(event) => {
                  const items = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void Promise.all(items.map((file) => aui.composer.addAttachment(file))).catch(onError);
                }}
              />
              <TooltipIconButton tooltip="添加附件" onClick={() => fileInput.current?.click()} aria-label="添加附件"><PaperclipIcon className="size-4" /></TooltipIconButton>
              <PopoverPrimitive.Root open={picker === "file"} onOpenChange={(open) => setPicker(open ? "file" : null)}>
                <PopoverPrimitive.Trigger asChild>
                  <TooltipIconButton tooltip="添加工程文件（@）" onClick={() => setPicker(picker === "file" ? null : "file")} aria-label="添加工程文件"><FileCodeIcon className="size-4" /></TooltipIconButton>
                </PopoverPrimitive.Trigger>
                <PickerContent align="start" side="top" className="w-80">
                  <div className="relative p-2 pb-1">
                    <SearchIcon className="pointer-events-none absolute start-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input autoFocus value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="搜索工程文件" aria-label="搜索工程文件" className="h-8 ps-8" />
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5 pt-1">
                    {!fileQuery && files.length > 0 && <PickerLabel>最近使用</PickerLabel>}
                    {filesLoading && <PickerEmpty><Loader2Icon className="size-4 animate-spin" />正在搜索</PickerEmpty>}
                    {!filesLoading && files.map((file) => (
                      <button key={file.path} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs outline-none hover:bg-accent focus:bg-accent" onClick={() => void attachWorkspaceFile(file)}>
                        <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                      </button>
                    ))}
                    {!filesLoading && !files.length && <PickerEmpty>{fileQuery ? "没有匹配文件" : "输入文件名开始搜索"}</PickerEmpty>}
                  </div>
                </PickerContent>
              </PopoverPrimitive.Root>
              <PopoverPrimitive.Root open={picker === "command"} onOpenChange={(open) => setPicker(open ? "command" : null)}>
                <PopoverPrimitive.Trigger asChild>
                  <TooltipIconButton tooltip="OpenCode 命令（/）" onClick={() => setPicker(picker === "command" ? null : "command")} aria-label="打开命令菜单"><SlashIcon className="size-4" /></TooltipIconButton>
                </PopoverPrimitive.Trigger>
                <PickerContent align="start" side="top" className="w-80">
                  <div className="relative p-2 pb-1">
                    <SearchIcon className="pointer-events-none absolute start-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="搜索命令" aria-label="搜索命令" className="h-8 ps-8" />
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5 pt-1">
                    {catalog.loading && <PickerEmpty><Loader2Icon className="size-4 animate-spin" />正在读取命令</PickerEmpty>}
                    {!catalog.loading && commands.map((command) => (
                      <button key={command.name} type="button" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus:bg-accent" onClick={() => { appendText(`/${command.name} `); setPicker(null); setCommandQuery(""); }}>
                        <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1"><span className="block text-xs font-medium">/{command.name}</span>{command.description && <span className="block truncate text-[10px] text-muted-foreground">{command.description}</span>}</span>
                      </button>
                    ))}
                    {!catalog.loading && !commands.length && <PickerEmpty>没有匹配命令</PickerEmpty>}
                  </div>
                </PickerContent>
              </PopoverPrimitive.Root>
            </div>

            <div className="ms-auto flex min-w-0 flex-1 items-center justify-end gap-1">
              <ModelPicker catalog={catalog} selection={selection} onSelectionChange={onSelectionChange} />
              <AgentPicker catalog={catalog} selection={selection} onSelectionChange={onSelectionChange} />
              {!isRunning ? (
                <TooltipIconButton type="submit" tooltip="发送（Enter）" variant="default" size="icon-sm" className="size-7 rounded-md" aria-label="发送消息" disabled={!canSend && !hasAttachments && !commandReady}><ArrowUpIcon className="size-4" /></TooltipIconButton>
              ) : (
                <ComposerPrimitive.Cancel asChild>
                  <Button variant="default" size="icon-sm" className="size-7 rounded-md" aria-label="停止生成"><SquareIcon className="size-3.5 fill-current" /></Button>
                </ComposerPrimitive.Cancel>
              )}
            </div>
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      <p className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-muted-foreground">
        <span>Enter 发送，Shift+Enter 换行</span>
        <span>{isRunning ? runState === "cancelling" ? "正在停止" : "OpenCode 正在执行" : session ? "上下文仅作用于当前会话" : "正在创建工作区会话"}</span>
      </p>
    </ComposerPrimitive.Root>
  );
}

function ModelPicker({ catalog, selection, onSelectionChange }: { catalog: OpenCodeCatalog; selection: OpenCodeSelection; onSelectionChange: (selection: OpenCodeSelection) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = catalog.models.find((item) => item.providerID === selection.model.providerID && item.modelID === selection.model.modelID);
  const models = catalog.models.filter((item) => !query.trim() || `${item.providerName} ${item.name} ${item.modelID}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 60);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="ghost" size="xs" className="min-w-0 max-w-36 justify-start gap-1 px-1.5 font-normal text-muted-foreground" aria-label="选择模型">
          <span className="truncate">{selected?.name ?? selection.model.modelID}</span><ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PickerContent align="end" side="top" className="w-80">
        <div className="relative p-2 pb-1"><SearchIcon className="pointer-events-none absolute start-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型" className="h-8 ps-8" /></div>
        <div className="max-h-72 overflow-y-auto p-1.5 pt-1">
          {catalog.loading && <PickerEmpty><Loader2Icon className="size-4 animate-spin" />正在读取模型</PickerEmpty>}
          {models.map((model) => {
            const active = model.providerID === selection.model.providerID && model.modelID === selection.model.modelID;
            return <button key={`${model.providerID}/${model.modelID}`} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus:bg-accent" onClick={() => { onSelectionChange({ ...selection, model: { providerID: model.providerID, modelID: model.modelID } }); setOpen(false); setQuery(""); }}>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{model.name}</span><span className="block truncate text-[10px] text-muted-foreground">{model.providerName}{formatContext(model.context) ? ` · ${formatContext(model.context)}` : ""}</span></span>{active && <CheckIcon className="size-3.5 shrink-0" />}
            </button>;
          })}
          {!catalog.loading && !models.length && <PickerEmpty>没有匹配模型</PickerEmpty>}
        </div>
      </PickerContent>
    </PopoverPrimitive.Root>
  );
}

function AgentPicker({ catalog, selection, onSelectionChange }: { catalog: OpenCodeCatalog; selection: OpenCodeSelection; onSelectionChange: (selection: OpenCodeSelection) => void }) {
  const agents = catalog.agents.filter((agent) => agent.mode !== "subagent");
  const selected = agents.find((item) => item.id === selection.agent);
  if (catalog.loading && !agents.length) return <span className="grid size-6 place-items-center text-muted-foreground"><Loader2Icon className="size-3 animate-spin" /></span>;
  if (!agents.length) return null;
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="ghost" size="xs" className="min-w-0 max-w-24 justify-start gap-1 px-1.5 font-normal text-muted-foreground" aria-label="选择 Agent"><BotIcon className="size-3.5 shrink-0" /><span className="truncate">{selected?.id ?? "Agent"}</span></Button>
      </PopoverPrimitive.Trigger>
      <PickerContent align="end" side="top" className="w-64">
        <div className="p-1.5">
          {agents.map((agent) => {
            const active = agent.id === selection.agent;
            return <PopoverPrimitive.Close key={agent.id} asChild><button type="button" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus:bg-accent" onClick={() => onSelectionChange({ ...selection, agent: agent.id })}><BotIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{agent.id}</span>{agent.description && <span className="block text-[10px] leading-snug text-muted-foreground">{agent.description}</span>}</span>{active && <CheckIcon className="mt-0.5 size-3.5 shrink-0" />}</button></PopoverPrimitive.Close>;
          })}
        </div>
      </PickerContent>
    </PopoverPrimitive.Root>
  );
}

function PickerContent({ className, ...props }: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content sideOffset={8} collisionPadding={12} className={cn("tf-agent-theme z-[100] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl outline-none", className)} {...props} /></PopoverPrimitive.Portal>;
}

function PickerLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">{children}</div>;
}

function PickerEmpty({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-muted-foreground">{children}</div>;
}
