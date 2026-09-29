import { useAui, useAuiState } from "@assistant-ui/react";
import {
  OpenCodeAttachmentAdapter,
  type OpencodeClient,
  useOpenCodeThreadState
} from "@assistant-ui/react-opencode";
import { PlusIcon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/errors.js";
import { useWiringTasks } from "../../lib/queries.js";
import { Button, IconButton, Kbd } from "../../ui";
import { AgentHeader, DrawerToggle, type HeaderProps } from "./AgentHeader";
import { OpenCodeComposer, useOpenCodeCatalog, useSessionSelection, type OpenCodeSelection } from "./OpenCodeComposer";
import { OpenCodeReasoningGroup, OpenCodeToolGroup } from "./OpenCodeGroups";
import { SidebarNotice } from "./RuntimeStates";
import { Thread } from "./Thread";
import { ThreadList } from "./ThreadList";
import { FallbackTool } from "./tools/OpenCodeTools";
import { isTaskActionable } from "../wiring/wiring-model.js";

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
    <SidebarNotice
      role="alert"
      tone="fail"
      className="inset-x-3 top-3"
      dismissLabel="关闭执行错误提示"
      onDismiss={() => setDismissed(error)}
    >
      <p className="font-medium text-fail">OpenCode 执行失败</p>
      <p className="mt-1 font-mono text-2xs break-words text-fg-2">{errorMessage(error)}</p>
      <Button className="mt-2" size="xs" variant="outline" onClick={onNewThread}>新建对话</Button>
    </SidebarNotice>
  );
}

function ThreadDrawer({ container, onThreadSelected }: { container: HTMLElement; onThreadSelected: () => void }) {
  return (
    <DialogPrimitive.Portal container={container}>
      <div>
        <DialogPrimitive.Overlay className="absolute inset-0 z-50 animate-fade-in bg-surface-0/60" />
        <DialogPrimitive.Content
          className={
            "absolute inset-y-0 start-0 z-[51] flex w-64 max-w-[85%] animate-fade-in flex-col border-e " +
            "border-line-strong bg-surface-1 text-fg shadow-overlay outline-none"
          }
        >
          <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line ps-3 pe-1">
            <div className="grid min-w-0 gap-px leading-tight">
              <DialogPrimitive.Title className="text-sm font-medium">会话历史</DialogPrimitive.Title>
              <DialogPrimitive.Description className="truncate text-2xs text-fg-3">
                搜索、切换或管理 OpenCode 会话
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭会话抽屉" size="icon-sm"><XIcon /></IconButton>
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2"><ThreadList onThreadSelected={onThreadSelected} /></div>
          <p className="flex items-center gap-1.5 border-t border-line px-3 py-1.5 text-2xs text-fg-3">
            <Kbd>Ctrl/Cmd+B</Kbd>切换<Kbd>Esc</Kbd>关闭
          </p>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

export function RunningShell({
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
  const pendingWiring = useWiringTasks().data?.filter(isTaskActionable).length ?? 0;

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
          drawerTrigger={<DrawerToggle trigger />}
          newThreadTrigger={
            <IconButton label="新建对话" size="icon-sm" onClick={createNewThread}><PlusIcon /></IconButton>
          }
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
              blockedReason={pendingWiring ? `等待操作员处理 ${pendingWiring} 个接线任务` : undefined}
            />,
            ToolFallback: FallbackTool,
            ToolGroup: OpenCodeToolGroup,
            ReasoningGroup: OpenCodeReasoningGroup
          }} />
          {workspace && <ThreadDrawer container={workspace} onThreadSelected={() => onDrawerOpenChange(false)} />}
        </div>
      </div>
    </DialogPrimitive.Root>
  );
}
