import { ComposerPrimitive, useAui, useAuiState, type PendingAttachment } from "@assistant-ui/react";
import {
  type OpencodeClient,
  OpenCodeAttachmentAdapter,
  type Session,
  useOpenCodeSession,
  useOpenCodeThreadState
} from "@assistant-ui/react-opencode";
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { cn, IconButton } from "../../ui";
import { ComposerAttachments } from "./Attachment";
import { UnattachedInteractions } from "./tools/interactions";
import { AgentPicker, CommandPicker, FilePicker, ModelPicker } from "./ComposerPickers";
import {
  filterOpenCodeCommands,
  parseOpenCodeCommand,
  recentFileOptions,
  rememberFile,
  REQUEST_OPTIONS,
  serializeOpenCodeCommandAttachments,
  type OpenCodeCatalog,
  type OpenCodeCommandOption,
  type OpenCodeFileOption,
  type OpenCodeSelection
} from "./composer-model";

export {
  filterOpenCodeCommands,
  parseOpenCodeCommand,
  serializeOpenCodeCommandAttachments,
  useOpenCodeCatalog,
  useSessionSelection,
  type OpenCodeCatalog,
  type OpenCodeCommandOption,
  type OpenCodeFileOption,
  type OpenCodeSelection
} from "./composer-model";

type Picker = "command" | "file" | null;

function useFileSearch(client: OpencodeClient, picker: Picker, query: string, onError: (reason: unknown) => void) {
  const [files, setFiles] = useState<OpenCodeFileOption[]>(recentFileOptions);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (picker !== "file") return;
    const trimmed = query.trim();
    if (!trimmed) {
      setFiles(recentFileOptions());
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void client.v2.fs.find({ query: trimmed, type: "file", limit: "20" }, REQUEST_OPTIONS).then((response) => {
        if (active) setFiles(response.data?.data ?? []);
      }).catch((reason) => {
        if (active) onError(reason);
      }).finally(() => {
        if (active) setLoading(false);
      });
    }, 160);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, query, onError, picker]);
  return { files, loading };
}

export function OpenCodeComposer({
  client,
  catalog,
  selection,
  onSelectionChange,
  attachmentAdapter,
  attachmentAccept,
  clientSession,
  onError,
  blockedReason
}: {
  client: OpencodeClient;
  catalog: OpenCodeCatalog;
  selection: OpenCodeSelection;
  onSelectionChange: (selection: OpenCodeSelection) => void;
  attachmentAdapter: OpenCodeAttachmentAdapter;
  attachmentAccept: string;
  clientSession?: Session | null;
  onError: (reason: unknown) => void;
  /** Set while the operator must answer an in-thread card (e.g. a wiring task); sending is held until then. */
  blockedReason?: string | undefined;
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
  const [picker, setPicker] = useState<Picker>(null);
  const [commandQuery, setCommandQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const { files, loading: filesLoading } = useFileSearch(client, picker, fileQuery, onError);
  const commands = useMemo(
    () => filterOpenCodeCommands(catalog.commands, commandQuery),
    [catalog.commands, commandQuery]
  );

  const appendText = useCallback((text: string) => {
    const composer = aui.composer;
    const current = composer.getState().text;
    composer.setText(current ? `${current}${current.endsWith("\n") ? "" : "\n"}${text}` : text);
  }, [aui]);

  const commandFromText = useCallback((text: string) => {
    return parseOpenCodeCommand(text, catalog.commands);
  }, [catalog.commands]);

  // A shortcut elsewhere in the app can hand us a draft. It may have arrived before this composer
  // mounted (the same click opened the sidebar), so drain on mount as well as on later requests.
  const { agent, model: { providerID, modelID } } = selection;
  const runCommand = useCallback(async () => {
    const composer = aui.composer;
    const state = composer.getState();
    const command = commandFromText(state.text);
    if (!command) return false;
    if (!session) throw new Error("OpenCode 会话尚未初始化");

    const attachments = await Promise.all(state.attachments.map(async (attachment) => {
      if (attachment.status.type === "complete") return attachment;
      if (attachment.status.type === "requires-action" && attachment.file) {
        return attachmentAdapter.send(attachment as PendingAttachment);
      }
      throw new Error("附件仍在处理中，请稍后重试");
    }));
    const parts = serializeOpenCodeCommandAttachments(attachments);
    if (parts.length !== attachments.length) throw new Error("自定义命令包含无法序列化的附件，请移除后重试");

    await client.session.command({
      sessionID: session.id,
      command: command.name,
      arguments: command.arguments,
      ...(agent ? { agent } : {}),
      model: `${providerID}/${modelID}`,
      ...(parts.length > 0 ? { parts } : {})
    }, REQUEST_OPTIONS);
    await composer.reset();
    return true;
  }, [attachmentAdapter, aui, client, commandFromText, agent, modelID, providerID, session]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    if (blockedReason) { event.preventDefault(); return; }
    const command = commandFromText(aui.composer.getState().text);
    if (!command) return;
    event.preventDefault();
    void runCommand().catch(onError);
  }, [aui, blockedReason, commandFromText, onError, runCommand]);

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

  const pickCommand = (command: OpenCodeCommandOption) => {
    appendText(`/${command.name} `);
    setPicker(null);
    setCommandQuery("");
  };

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

  const status = blockedReason ?? (isRunning
    ? runState === "cancelling" ? "正在停止" : "OpenCode 正在执行"
    : session ? "上下文仅作用于当前会话" : "正在创建工作区会话");

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col gap-2" onSubmit={handleSubmit}>
      <UnattachedInteractions />
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          className={cn(
            "flex w-full flex-col gap-1.5 rounded-md border border-line-strong bg-surface-0 p-1.5",
            "transition-colors duration-120 focus-within:border-signal",
            "data-[dragging=true]:border-dashed data-[dragging=true]:border-signal data-[dragging=true]:bg-signal/6"
          )}
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder={blockedReason ? "请先在上方卡片中处理接线任务" : "输入任务，使用 @ 添加文件，使用 / 调用命令"}
            disabled={Boolean(blockedReason)}
            className={cn(
              "max-h-40 min-h-12 w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-fg",
              "outline-none placeholder:text-fg-3"
            )}
            rows={1}
            autoFocus
            enterKeyHint="send"
            aria-label="消息"
            onKeyDown={handleInputKeyDown}
            submitMode={blockedReason ? "none" : "enter"}
          />

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
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
              <IconButton label="添加附件" size="icon-sm" side="top" onClick={() => fileInput.current?.click()}>
                <PaperclipIcon />
              </IconButton>
              <FilePicker
                open={picker === "file"}
                onOpenChange={(open) => setPicker(open ? "file" : null)}
                onToggle={() => setPicker(picker === "file" ? null : "file")}
                query={fileQuery}
                onQueryChange={setFileQuery}
                files={files}
                loading={filesLoading}
                onPick={(file) => void attachWorkspaceFile(file)}
              />
              <CommandPicker
                open={picker === "command"}
                onOpenChange={(open) => setPicker(open ? "command" : null)}
                onToggle={() => setPicker(picker === "command" ? null : "command")}
                query={commandQuery}
                onQueryChange={setCommandQuery}
                commands={commands}
                loading={catalog.loading}
                onPick={pickCommand}
              />
            </div>

            <div className="ms-auto flex min-w-0 flex-1 items-center justify-end gap-1">
              <ModelPicker catalog={catalog} selection={selection} onSelectionChange={onSelectionChange} />
              <AgentPicker catalog={catalog} selection={selection} onSelectionChange={onSelectionChange} />
              {!isRunning ? (
                <IconButton
                  type="submit"
                  label="发送消息"
                  side="top"
                  variant="primary"
                  size="icon-sm"
                  disabled={Boolean(blockedReason) || (!canSend && !hasAttachments && !commandReady)}
                >
                  <ArrowUpIcon />
                </IconButton>
              ) : (
                <ComposerPrimitive.Cancel asChild>
                  <IconButton label="停止生成" side="top" variant="danger" size="icon-sm">
                    <SquareIcon className="size-3 fill-current" />
                  </IconButton>
                </ComposerPrimitive.Cancel>
              )}
            </div>
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      <p className="mt-1 flex items-center justify-between gap-2 px-1 text-2xs text-fg-3">
        <span>Enter 发送，Shift+Enter 换行</span>
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {blockedReason
            ? <span aria-hidden className="size-1.5 shrink-0 animate-lamp rounded-full bg-signal" />
            : isRunning && <span aria-hidden className="size-1.5 shrink-0 animate-lamp rounded-full bg-run" />}
          {status}
        </span>
      </p>
    </ComposerPrimitive.Root>
  );
}
