import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState
} from "@assistant-ui/react";
import {
  OpenCodeAttachmentAdapter,
  type OpencodeClient,
  useOpenCodeRuntime,
  useOpenCodeSession,
  useOpenCodeThreadState
} from "@assistant-ui/react-opencode";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpenCodeRuntimeStatus } from "@hardwareharness/contracts/agents";
import type { LlmSettings } from "@hardwareharness/contracts/storage";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import {
  AlertCircleIcon,
  BotIcon,
  KeyRoundIcon,
  Loader2Icon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
  SquareIcon,
  XIcon
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { OpenCodeDataPart } from "./OpenCodeDataPart";
import {
  OpenCodeComposer,
  useOpenCodeCatalog,
  useSessionSelection,
  type OpenCodeSelection
} from "./OpenCodeComposer";
import { OpenCodeReasoningGroup, OpenCodeToolGroup } from "./OpenCodeGroups";
import { usePersistedThreadDrawer } from "./drawer";
import { Thread } from "./Thread";
import { ThreadList } from "./ThreadList";
import { Button, TooltipIconButton } from "../../shared/ui/index.js";
import { FallbackTool } from "./tools/OpenCodeTools";
import { OpenCodeToolUIs } from "./tools/toolkit";
import {
  createWorkspaceOpencodeClient,
  persistWorkspaceThread,
  resolveWorkspaceThread
} from "./workspace-opencode-client";

const WIDTH_KEY = "hardwareharness.assistant-sidebar-width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 300;

const stateLabels: Record<OpenCodeRuntimeStatus["state"], string> = {
  running: "已就绪",
  starting: "启动中",
  stopping: "停止中",
  stopped: "已停止",
  error: "启动失败"
};

function maxSidebarWidth() {
  return Math.min(720, Math.max(MIN_WIDTH, window.innerWidth - 468));
}

export function AssistantSidebar({ gatewayRunning, onClose, onOpenSettings }: { gatewayRunning: boolean; onClose: () => void; onOpenSettings: () => void }) {
  const rootRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  const [actionError, setActionError] = useState<string>();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: queryKeys.openCodeStatus, queryFn: () => window.hardwareharness.agents.openCodeStatus(), refetchInterval: 5_000 });
  const settingsQuery = useQuery({ queryKey: queryKeys.llmSettings, queryFn: () => window.hardwareharness.settings.getLlm() });
  const current = statusQuery.data;
  const settings = settingsQuery.data;
  const running = current?.state === "running" && current.workspaceState === "ready" && Boolean(current.apiUrl) && Boolean(current.workspace);
  const [drawerOpen, setDrawerOpen] = usePersistedThreadDrawer(running);

  useEffect(() => window.hardwareharness.events.subscribe("opencode", () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.openCodeStatus });
  }), [queryClient]);

  useEffect(() => setActionError(undefined), [current?.apiUrl, current?.workspace]);

  const setWidth = (next: number) => {
    const width = Math.round(Math.min(maxSidebarWidth(), Math.max(MIN_WIDTH, next)));
    rootRef.current?.style.setProperty("--tf-agent-sidebar-width", `${width}px`);
    const separator = rootRef.current?.querySelector<HTMLElement>(".tf-agent-resize-handle");
    separator?.setAttribute("aria-valuenow", String(width));
    separator?.setAttribute("aria-valuemax", String(maxSidebarWidth()));
    return width;
  };

  useEffect(() => {
    const saved = Number.parseInt(localStorage.getItem(WIDTH_KEY) ?? "", 10);
    setWidth(Number.isFinite(saved) ? saved : DEFAULT_WIDTH);
    const onResize = () => {
      if (!rootRef.current) return;
      const width = setWidth(rootRef.current.getBoundingClientRect().width);
      localStorage.setItem(WIDTH_KEY, String(width));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      document.body.classList.remove("is-resizing-agent-sidebar");
    };
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rootRef.current) return;
    resizeRef.current = { startX: event.clientX, startWidth: rootRef.current.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = "true";
    document.body.classList.add("is-resizing-agent-sidebar");
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current) setWidth(resizeRef.current.startWidth + resizeRef.current.startX - event.clientX);
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current || !rootRef.current) return;
    resizeRef.current = undefined;
    event.currentTarget.dataset.dragging = "false";
    document.body.classList.remove("is-resizing-agent-sidebar");
    localStorage.setItem(WIDTH_KEY, String(Math.round(rootRef.current.getBoundingClientRect().width)));
  };
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rootRef.current) return;
    const current = rootRef.current.getBoundingClientRect().width;
    const next = event.key === "ArrowLeft" ? current + 16 : event.key === "ArrowRight" ? current - 16 : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxSidebarWidth() : undefined;
    if (next === undefined) return;
    event.preventDefault();
    localStorage.setItem(WIDTH_KEY, String(setWidth(next)));
  };

  const headerProps = {
    status: current,
    onClose
  };

  return (
    <aside ref={rootRef} className="tf-agent-sidebar" aria-label="OpenCode AI 助手">
      <div
        className="tf-agent-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="调整 AI 助手侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={720}
        aria-valuenow={DEFAULT_WIDTH}
        title="拖动调整宽度，双击恢复默认宽度"
        onDoubleClick={() => localStorage.setItem(WIDTH_KEY, String(setWidth(DEFAULT_WIDTH)))}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
      />
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {running && current?.apiUrl && settings ? (
          <OpenCodeAssistant
            apiUrl={current.apiUrl}
            workspace={current.workspace!}
            model={settings.model}
            drawerOpen={drawerOpen}
            onDrawerOpenChange={setDrawerOpen}
            onRuntimeError={(reason) => setActionError(errorMessage(reason))}
            headerProps={headerProps}
          />
        ) : (
          <>
            <AgentHeader {...headerProps} drawerEnabled={false} />
            <RuntimeEmptyState
              status={current}
              settings={settings}
              loading={statusQuery.isLoading || settingsQuery.isLoading}
              error={actionError ?? (statusQuery.error ? errorMessage(statusQuery.error) : settingsQuery.error ? errorMessage(settingsQuery.error) : undefined)}
              gatewayRunning={gatewayRunning}
              onOpenSettings={onOpenSettings}
            />
          </>
        )}
        {running && !gatewayRunning && <div role="status" className="absolute right-3 bottom-3 z-40 rounded-lg border border-amber-500/30 bg-background/95 px-3 py-2 text-xs text-amber-700 shadow-md dark:text-amber-400">MCP Gateway 未运行，设备工具暂不可用。</div>}
        {running && actionError && <div role="alert" className="absolute inset-x-3 bottom-3 z-40 flex items-start gap-2 rounded-lg border border-destructive/30 bg-background/95 p-3 text-xs text-destructive shadow-md"><AlertCircleIcon className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 flex-1">{actionError}</span><button aria-label="关闭错误提示" onClick={() => setActionError(undefined)}><XIcon className="size-3.5" /></button></div>}
      </div>
    </aside>
  );
}

type HeaderProps = {
  status: OpenCodeRuntimeStatus | undefined;
  onClose: () => void;
};

function AgentHeader({ drawerEnabled, drawerTrigger, newThreadTrigger, ...props }: HeaderProps & { drawerEnabled: boolean; drawerTrigger?: ReactNode; newThreadTrigger?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 bg-card px-2">
      {drawerTrigger ?? <TooltipIconButton tooltip="会话历史（Ctrl/Cmd+B）" disabled={!drawerEnabled} aria-label="打开会话抽屉"><PanelLeftIcon className="size-4" /></TooltipIconButton>}
      <div className="min-w-0 flex-1 px-1">
        <div className="flex items-center gap-1.5 text-sm font-medium"><BotIcon className="size-3.5 shrink-0" /><span>OpenCode</span></div>
        {drawerEnabled ? <SelectedSessionTitle /> : <div className="truncate text-[11px] leading-tight text-muted-foreground">{props.status?.workspace ?? "HardwareHarness Agent"}</div>}
      </div>
      <span className="tf-agent-readonly-status" aria-label={`OpenCode 状态：${stateLabels[props.status?.state ?? "stopped"]}`}>{stateLabels[props.status?.state ?? "stopped"]}</span>
      {newThreadTrigger}
      <TooltipIconButton tooltip="关闭侧栏" onClick={props.onClose} aria-label="关闭 AI 助手"><XIcon className="size-4" /></TooltipIconButton>
    </header>
  );
}

function SelectedSessionTitle() {
  const session = useOpenCodeSession();
  return <div className="truncate text-[11px] leading-tight text-muted-foreground">{session?.title?.trim() || "新对话"}</div>;
}

function RuntimeEmptyState({
  status,
  settings,
  loading,
  error,
  gatewayRunning,
  onOpenSettings
}: {
  status: OpenCodeRuntimeStatus | undefined;
  settings: LlmSettings | undefined;
  loading: boolean;
  error: string | undefined;
  gatewayRunning: boolean;
  onOpenSettings: () => void;
}) {
  let icon: ReactNode = <BotIcon className="size-7" />;
  let title = "正在读取助手状态";
  let body = "请稍候…";
  let actions: ReactNode;
  if (!loading && !settings?.apiKeyConfigured) {
    icon = <KeyRoundIcon className="size-7" />;
    title = "先完成模型配置";
    body = "填写 OpenAI 兼容地址、模型 ID 和 API Key。保存有效密钥后，OpenCode 会自动启动。";
    actions = <Button size="sm" onClick={onOpenSettings}><SettingsIcon />打开设置</Button>;
  } else if (status?.state === "starting" || status?.state === "stopping") {
    icon = <Loader2Icon className="size-7 animate-spin" />;
    title = status.state === "starting" ? "正在启动 OpenCode" : "正在停止 OpenCode";
    body = status.state === "starting" ? "窗口保持可用，启动完成后会自动进入会话。" : "正在回收本地 sidecar 进程。";
  } else if (status?.state === "error" || error) {
    icon = <AlertCircleIcon className="size-7 text-destructive" />;
    title = "OpenCode 启动失败";
    body = error ?? status?.message ?? "请检查模型配置后重试。";
    actions = <Button size="sm" variant="outline" onClick={onOpenSettings}><SettingsIcon />打开设置</Button>;
  } else if (status?.state === "running" && (!status.workspace || status.workspaceState !== "ready")) {
    icon = <AlertCircleIcon className="size-7 text-destructive" />;
    title = "OpenCode 工作区不可用";
    body = "请重新打开项目文件夹，侧栏只会加载当前工作区的会话。";
  } else if (status?.state === "stopped") {
    icon = <SquareIcon className="size-7" />;
    title = "OpenCode 已停止";
    body = status?.workspaceState === "requires_project" ? "请先打开项目文件夹。" : "请在设置页启动 OpenCode，本地会话历史会保留。";
    actions = <Button size="sm" onClick={onOpenSettings}><SettingsIcon />打开设置</Button>;
  }
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
      <section className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">{icon}</div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
        {!gatewayRunning && <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">MCP Gateway 当前未运行，启动后设备工具仍可能不可用。</p>}
        {actions && <div className="mt-5">{actions}</div>}
      </section>
    </div>
  );
}

function SetFallbackDataUI() {
  const aui = useAui();
  useEffect(() => aui.dataRenderers.setFallbackDataUI(OpenCodeDataPart), [aui]);
  return null;
}

function OpenCodeAssistant({
  apiUrl,
  workspace,
  model,
  drawerOpen,
  onDrawerOpenChange,
  onRuntimeError,
  headerProps
}: {
  apiUrl: string;
  workspace: string;
  model: string;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  onRuntimeError: (reason: unknown) => void;
  headerProps: HeaderProps;
}) {
  const client = useMemo(() => createWorkspaceOpencodeClient(apiUrl, workspace), [apiUrl, workspace]);
  const [resolution, setResolution] = useState<{ state: "loading" } | { state: "ready"; sessionId: string | undefined } | { state: "error"; error: unknown }>({ state: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let active = true;
    setResolution({ state: "loading" });
    void resolveWorkspaceThread(client, workspace, localStorage).then((sessionId) => {
      if (active) setResolution({ state: "ready", sessionId });
    }).catch((error) => {
      if (active) setResolution({ state: "error", error });
    });
    return () => { active = false; };
  }, [client, retryToken, workspace]);

  if (resolution.state !== "ready") {
    return (
      <>
        <AgentHeader {...headerProps} drawerEnabled={false} />
        <SessionResolutionState
          error={resolution.state === "error" ? resolution.error : undefined}
          onRetry={() => setRetryToken((value) => value + 1)}
        />
      </>
    );
  }

  return (
    <OpenCodeRuntimeAssistant
      key={`${apiUrl}\u0000${workspace}\u0000${resolution.sessionId ?? "new"}`}
      client={client}
      workspace={workspace}
      initialSessionId={resolution.sessionId}
      model={model}
      drawerOpen={drawerOpen}
      onDrawerOpenChange={onDrawerOpenChange}
      onRuntimeError={onRuntimeError}
      headerProps={headerProps}
    />
  );
}

function SessionResolutionState({ error, onRetry }: { error: unknown | undefined; onRetry: () => void }) {
  const hasError = error !== undefined;
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
      <section className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
          {hasError ? <AlertCircleIcon className="size-7 text-destructive" /> : <Loader2Icon className="size-7 animate-spin" />}
        </div>
        <h2 className="text-base font-semibold">{hasError ? "恢复工作区会话失败" : "正在恢复工作区会话"}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{hasError ? errorMessage(error) : "正在查找当前项目最近使用的会话；如果没有，将自动创建新对话。"}</p>
        {hasError && <Button className="mt-5" size="sm" variant="outline" onClick={onRetry}>重试</Button>}
      </section>
    </div>
  );
}

function OpenCodeRuntimeAssistant({
  client,
  workspace,
  initialSessionId,
  model,
  drawerOpen,
  onDrawerOpenChange,
  onRuntimeError,
  headerProps
}: {
  client: OpencodeClient;
  workspace: string;
  initialSessionId: string | undefined;
  model: string;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  onRuntimeError: (reason: unknown) => void;
  headerProps: HeaderProps;
}) {
  const attachments = useMemo(() => new OpenCodeAttachmentAdapter(), []);
  const fallbackSelection = useMemo<OpenCodeSelection>(() => ({ model: { providerID: "openai", modelID: model } }), [model]);
  const [selection, setSelection] = useState<OpenCodeSelection>(fallbackSelection);
  const onThreadIdChange = useCallback((threadId: string | undefined) => {
    if (threadId) persistWorkspaceThread(localStorage, workspace, threadId);
  }, [workspace]);
  const runtime = useOpenCodeRuntime({
    client,
    ...(initialSessionId ? { initialSessionId } : {}),
    onThreadIdChange,
    defaultModel: selection.model,
    defaultAgent: selection.agent,
    adapters: { attachments },
    onError: onRuntimeError
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <OpenCodeToolUIs />
      <SetFallbackDataUI />
      <RunningShell
        client={client}
        fallbackSelection={fallbackSelection}
        selection={selection}
        onSelectionChange={setSelection}
        attachmentAdapter={attachments}
        attachmentAccept={attachments.accept}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={onDrawerOpenChange}
        onRuntimeError={onRuntimeError}
        headerProps={headerProps}
      />
    </AssistantRuntimeProvider>
  );
}

function RunningShell({
  client,
  fallbackSelection,
  selection,
  onSelectionChange,
  attachmentAdapter,
  attachmentAccept,
  drawerOpen,
  onDrawerOpenChange,
  onRuntimeError,
  headerProps
}: {
  client: OpencodeClient;
  fallbackSelection: OpenCodeSelection;
  selection: OpenCodeSelection;
  onSelectionChange: (selection: OpenCodeSelection) => void;
  attachmentAdapter: OpenCodeAttachmentAdapter;
  attachmentAccept: string;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  onRuntimeError: (reason: unknown) => void;
  headerProps: HeaderProps;
}) {
  const [workspace, setWorkspace] = useState<HTMLDivElement | null>(null);
  const catalog = useOpenCodeCatalog(client, fallbackSelection.model.modelID);
  const [sessionSelection, setSessionSelection] = useSessionSelection(selection);
  const aui = useAui();

  useEffect(() => {
    if (
      selection.model.providerID === sessionSelection.model.providerID &&
      selection.model.modelID === sessionSelection.model.modelID &&
      selection.agent === sessionSelection.agent
    ) return;
    onSelectionChange(sessionSelection);
  }, [onSelectionChange, selection.agent, selection.model.modelID, selection.model.providerID, sessionSelection]);

  const createNewThread = useCallback(() => {
    const runtime = aui.threads.__internal_getAssistantRuntime?.();
    if (!runtime) {
      onRuntimeError(new Error("OpenCode 会话运行时尚未就绪"));
      return;
    }
    void (async () => {
      try {
        await runtime.threads.switchToNewThread();
        if (runtime.threads.mainItem.getState().status === "new") await runtime.threads.mainItem.initialize();
      } catch (reason) {
        onRuntimeError(reason);
      }
    })();
  }, [aui, onRuntimeError]);

  return (
    <DialogPrimitive.Root open={drawerOpen} onOpenChange={onDrawerOpenChange}>
      <div className="flex min-h-0 flex-1 flex-col">
        <AutoInitializeThread onError={onRuntimeError} />
        <AgentHeader
          {...headerProps}
          drawerEnabled
          drawerTrigger={
            <DialogPrimitive.Trigger asChild>
              <TooltipIconButton tooltip="会话历史（Ctrl/Cmd+B）" aria-label="打开会话抽屉"><PanelLeftIcon className="size-4" /></TooltipIconButton>
            </DialogPrimitive.Trigger>
          }
          newThreadTrigger={<TooltipIconButton tooltip="新建对话" aria-label="新建对话" onClick={createNewThread}><PlusIcon className="size-4" /></TooltipIconButton>}
        />
        <div ref={setWorkspace} className="relative min-h-0 flex-1 overflow-hidden">
          <OpenCodeRunErrorNotice onNewThread={createNewThread} />
          <Thread components={{
            Composer: <OpenCodeComposer
              client={client}
              catalog={catalog}
              selection={sessionSelection}
              onSelectionChange={setSessionSelection}
              attachmentAdapter={attachmentAdapter}
              attachmentAccept={attachmentAccept}
              onError={onRuntimeError}
            />,
            ToolFallback: FallbackTool,
            ToolGroup: OpenCodeToolGroup,
            ReasoningGroup: OpenCodeReasoningGroup
          }} />
          {workspace && (
            <DialogPrimitive.Portal container={workspace}>
              <div>
                <DialogPrimitive.Overlay className="absolute inset-0 z-50 bg-black/25 backdrop-blur-[1px]" />
                <DialogPrimitive.Content className="absolute inset-y-0 start-0 z-[51] flex w-64 max-w-[85%] flex-col bg-card text-card-foreground shadow-xl outline-none ring-1 ring-border">
                  <header className="flex h-12 shrink-0 items-center justify-between bg-card px-3">
                    <div><DialogPrimitive.Title className="text-sm font-semibold">会话历史</DialogPrimitive.Title><DialogPrimitive.Description className="text-[10px] text-muted-foreground">搜索、切换或管理 OpenCode 会话</DialogPrimitive.Description></div>
                    <DialogPrimitive.Close asChild><TooltipIconButton tooltip="关闭会话抽屉" aria-label="关闭会话抽屉"><XIcon className="size-4" /></TooltipIconButton></DialogPrimitive.Close>
                  </header>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2"><ThreadList onThreadSelected={() => onDrawerOpenChange(false)} /></div>
                  <p className="bg-secondary/40 px-3 py-2 text-[10px] text-muted-foreground">Ctrl/Cmd+B 切换，Esc 关闭</p>
                </DialogPrimitive.Content>
              </div>
            </DialogPrimitive.Portal>
          )}
        </div>
      </div>
    </DialogPrimitive.Root>
  );
}

function AutoInitializeThread({ onError }: { onError: (reason: unknown) => void }) {
  const aui = useAui();
  const threadsLoading = useAuiState((state) => state.threads.isLoading);
  const threadStatus = useAuiState((state) => state.threadListItem.status);
  const attempted = useRef(false);

  useEffect(() => {
    if (threadsLoading || threadStatus !== "new" || attempted.current) return;
    const runtime = aui.threads.__internal_getAssistantRuntime?.();
    if (!runtime) return;
    attempted.current = true;
    void runtime.threads.mainItem.initialize().catch(onError);
  }, [aui, onError, threadStatus, threadsLoading]);
  return null;
}

function OpenCodeRunErrorNotice({ onNewThread }: { onNewThread: () => void }) {
  const error = useOpenCodeThreadState((state) => state.runState.type === "error" ? state.runState.error : undefined);
  const sessionId = useOpenCodeThreadState((state) => state.sessionId);
  const [dismissed, setDismissed] = useState<unknown>();

  useEffect(() => setDismissed(undefined), [sessionId]);
  if (error === undefined || dismissed === error) return null;

  return (
    <div role="alert" className="absolute inset-x-3 top-3 z-40 flex items-start gap-2 rounded-lg border border-destructive/30 bg-background/95 p-3 text-xs text-destructive shadow-md">
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">OpenCode 执行失败</p>
        <p className="mt-1 break-words text-foreground/80">{errorMessage(error)}</p>
        <Button className="mt-2" size="xs" variant="outline" onClick={onNewThread}>新建对话</Button>
      </div>
      <button type="button" aria-label="关闭执行错误提示" onClick={() => setDismissed(error)}><XIcon className="size-3.5" /></button>
    </div>
  );
}
