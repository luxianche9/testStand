import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
import { OpenCodeAttachmentAdapter, type OpencodeClient, useOpenCodeRuntime } from "@assistant-ui/react-opencode";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { errorMessage } from "../../lib/errors.js";
import { useLlmSettings, useOpenCodeStatus } from "../../lib/queries.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { Splitter } from "../../ui";
import { AgentHeader, type HeaderProps } from "./AgentHeader";
import { usePersistedThreadDrawer } from "./drawer";
import { OpenCodeDataPart } from "./OpenCodeDataPart";
import type { OpenCodeSelection } from "./OpenCodeComposer";
import { RunningShell } from "./RunningShell";
import { RuntimeEmptyState, SessionResolutionState, SidebarNotice } from "./RuntimeStates";
import { OpenCodeToolUIs } from "./tools/toolkit";
import {
  createWorkspaceOpencodeClient,
  persistWorkspaceThread,
  resolveWorkspaceThread
} from "./workspace-opencode-client";

const maxSidebarWidth = () => Math.min(720, window.innerWidth - 468);

export function AssistantSidebar({ gatewayRunning, onClose, onOpenSettings }: {
  gatewayRunning: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const { width, separatorProps } = useResizableWidth({
    storageKey: "teststand.assistant-sidebar-width",
    defaultWidth: 420,
    min: 300,
    max: maxSidebarWidth,
    direction: "left"
  });
  const [actionError, setActionError] = useState<string>();
  // The "opencode" push event is handled centrally by useTestStandEvents (mounted in Shell).
  const statusQuery = useOpenCodeStatus();
  const settingsQuery = useLlmSettings();
  const current = statusQuery.data;
  const settings = settingsQuery.data;
  const running = current?.state === "running" && current.workspaceState === "ready"
    && Boolean(current.apiUrl) && Boolean(current.workspace);
  const [drawerOpen, setDrawerOpen] = usePersistedThreadDrawer(running);

  useEffect(() => setActionError(undefined), [current?.apiUrl, current?.workspace]);

  const headerProps: HeaderProps = { status: current, onClose };
  const queryError = statusQuery.error ?? settingsQuery.error;
  const style = { "--tf-agent-sidebar-width": `${width}px` } as CSSProperties;

  return (
    <aside className="tf-agent-sidebar" aria-label="OpenCode AI 助手" style={style}>
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface-1">
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
              error={actionError ?? (queryError ? errorMessage(queryError) : undefined)}
              gatewayRunning={gatewayRunning}
              onOpenSettings={onOpenSettings}
            />
          </>
        )}
        {running && !gatewayRunning && (
          <SidebarNotice role="status" tone="signal" className="right-3 bottom-3 max-w-[calc(100%-1.5rem)]">
            MCP Gateway 未运行，设备工具暂不可用。
          </SidebarNotice>
        )}
        {running && actionError && (
          <SidebarNotice
            role="alert"
            tone="fail"
            className="inset-x-3 bottom-3"
            dismissLabel="关闭错误提示"
            onDismiss={() => setActionError(undefined)}
          >
            <span className="break-words">{actionError}</span>
          </SidebarNotice>
        )}
      </div>
      <Splitter label="调整 AI 助手侧栏宽度" {...separatorProps} className="absolute inset-y-0 left-0 z-[70]" />
    </aside>
  );
}

function SetFallbackDataUI() {
  const aui = useAui();
  useEffect(() => aui.dataRenderers.setFallbackDataUI(OpenCodeDataPart), [aui]);
  return null;
}

type AssistantProps = {
  model: string;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  onRuntimeError: (reason: unknown) => void;
  headerProps: HeaderProps;
};

type Resolution =
  | { state: "loading" }
  | { state: "ready"; sessionId: string | undefined }
  | { state: "error"; error: unknown };

function OpenCodeAssistant({ apiUrl, workspace, ...props }: AssistantProps & { apiUrl: string; workspace: string }) {
  const client = useMemo(() => createWorkspaceOpencodeClient(apiUrl, workspace), [apiUrl, workspace]);
  const [resolution, setResolution] = useState<Resolution>({ state: "loading" });
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
        <AgentHeader {...props.headerProps} drawerEnabled={false} />
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
      {...props}
    />
  );
}

function OpenCodeRuntimeAssistant({ client, workspace, initialSessionId, model, onRuntimeError, ...props }:
  AssistantProps & { client: OpencodeClient; workspace: string; initialSessionId: string | undefined }) {
  const attachments = useMemo(() => new OpenCodeAttachmentAdapter(), []);
  const fallbackSelection = useMemo<OpenCodeSelection>(
    () => ({ model: { providerID: "llm", modelID: model } }),
    [model]
  );
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
        onRuntimeError={onRuntimeError}
        {...props}
      />
    </AssistantRuntimeProvider>
  );
}
