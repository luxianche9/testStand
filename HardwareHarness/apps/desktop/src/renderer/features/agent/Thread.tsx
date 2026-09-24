import { AuiIf, ComposerPrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { ArrowDownIcon, ArrowUpIcon, SquareIcon } from "lucide-react";
import { useContext, type FC } from "react";
import { cn, IconButton } from "../../ui";
import { AssistantMessage } from "./AssistantMessage";
import { EMPTY_COMPONENTS, isNewChatView, ThreadComponentsContext, type ThreadComponents } from "./thread-context";
import { EditComposer, UserMessage } from "./UserMessage";

export type { ThreadComponents } from "./thread-context";

export const Thread: FC<{ components?: ThreadComponents }> = ({ components = EMPTY_COMPONENTS }) => {
  const empty = useAuiState(isNewChatView);
  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot empty={empty} />
    </ThreadComponentsContext.Provider>
  );
};

function ThreadRoot({ empty }: { empty: boolean }) {
  const { Welcome = ThreadWelcome, Composer: ComposerComponent } = useContext(ThreadComponentsContext);
  return (
    <ThreadPrimitive.Root
      className="aui-root tf-agent-thread @container flex h-full min-h-0 flex-col bg-surface-1"
      style={{ ["--thread-max-width" as string]: "44rem" }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-3 pt-3">
          <AuiIf condition={isNewChatView}><Welcome /></AuiIf>
          <div data-slot="aui_message-group" className="mb-10 flex flex-col gap-y-5 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter
            data-empty={empty || undefined}
            className={cn(
              "sticky bottom-0 z-10 -mx-3 mt-auto flex flex-col gap-2 overflow-visible",
              "border-t border-line bg-surface-1 px-3 pt-2 pb-2"
            )}
          >
            <ThreadScrollToBottom />
            {ComposerComponent ?? <Composer />}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function ThreadMessage() {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } = useContext(ThreadComponentsContext);
  const role = useAuiState((state) => state.message.role);
  const editing = useAuiState((state) => state.message.composer.isEditing);
  if (editing) return <EditComposer />;
  return role === "user" ? <UserMessage /> : <AssistantMessageComponent />;
}

function ThreadWelcome() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center">
      <span className="tf-label mb-2">OpenCode · HardwareHarness MCP</span>
      <h1 className="text-base font-semibold text-fg">今天想一起完成什么？</h1>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-2">
        可以分析当前工程、修改文件、执行测试，或通过 HardwareHarness MCP 调用设备工具。
      </p>
    </div>
  );
}

function ThreadScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <IconButton
        label="回到底部"
        variant="secondary"
        side="top"
        className="absolute -top-10 z-10 self-center rounded-full shadow-overlay disabled:invisible"
      >
        <ArrowDownIcon />
      </IconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <div
        className={
          "flex w-full flex-col gap-1.5 rounded-md border border-line-strong bg-surface-0 p-1.5 " +
          "transition-colors duration-120 focus-within:border-signal"
        }
      >
        <ComposerPrimitive.Input
          placeholder="输入消息…"
          className={
            "max-h-32 min-h-9 w-full resize-none bg-transparent px-1.5 py-1 text-sm text-fg outline-none " +
            "placeholder:text-fg-3"
          }
          rows={1}
          autoFocus
          enterKeyHint="send"
          aria-label="消息"
        />
        <ComposerAction />
      </div>
      <p className="mt-1 px-1 text-2xs text-fg-3">Enter 发送，Shift+Enter 换行</p>
    </ComposerPrimitive.Root>
  );
}

function ComposerAction() {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <AuiIf condition={(state) => !state.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <IconButton label="发送消息" side="top" variant="primary"><ArrowUpIcon className="size-4" /></IconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(state) => state.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <IconButton label="停止生成" side="top" variant="danger">
            <SquareIcon className="size-3 fill-current" />
          </IconButton>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
}
