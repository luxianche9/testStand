import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon
} from "lucide-react";
import { createContext, useContext, type ComponentType, type FC, type PropsWithChildren, type ReactNode } from "react";
import { UserMessageAttachments } from "./Attachment";
import { MarkdownText } from "./MarkdownText";
import { Reasoning, ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "./Reasoning";
import { ToolFallback } from "./ToolFallback";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "./ToolGroup";
import { Button, TooltipIconButton } from "../../shared/ui/index.js";
import { cn } from "../../shared/ui/index.js";

type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;
export type ThreadComponents = {
  AssistantMessage?: ComponentType;
  Welcome?: ComponentType;
  Composer?: ReactNode;
  ToolFallback?: ToolCallMessagePartComponent;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>;
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>;
};

const EMPTY_COMPONENTS: ThreadComponents = {};
const ThreadComponentsContext = createContext(EMPTY_COMPONENTS);
const isNewChatView = (state: AssistantState) =>
  state.thread.messages.length === 0 && (!state.thread.isLoading || state.threads.isLoading);

export const Thread: FC<{ components?: ThreadComponents }> = ({ components = EMPTY_COMPONENTS }) => {
  const empty = useAuiState(isNewChatView);
  return <ThreadComponentsContext.Provider value={components}><ThreadRoot empty={empty} /></ThreadComponentsContext.Provider>;
};

function ThreadRoot({ empty }: { empty: boolean }) {
  const { Welcome = ThreadWelcome, Composer: ComposerComponent } = useContext(ThreadComponentsContext);
  return (
    <ThreadPrimitive.Root
      className="aui-root tf-agent-thread @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "color-mix(in oklab, var(--color-muted) 30%, var(--color-background))",
        ["--composer-radius" as string]: "1.25rem"
      }}
    >
      <ThreadPrimitive.Viewport turnAnchor="top" data-slot="aui_thread-viewport" className="relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth">
        <div className={cn("mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-3 pt-4", empty && "justify-center")}>
          <AuiIf condition={isNewChatView}><Welcome /></AuiIf>
          <div data-slot="aui_message-group" className="mb-12 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className={cn("flex flex-col gap-3 overflow-visible bg-background pb-4", !empty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)")}>
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
    <div className="mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="text-xl font-semibold">今天想一起完成什么？</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">可以分析当前工程、修改文件、执行测试，或通过 TestForge MCP 调用设备工具。</p>
    </div>
  );
}

function ThreadScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton tooltip="回到底部" variant="outline" className="absolute -top-11 z-10 size-8 self-center rounded-full bg-background p-2 shadow-sm disabled:invisible">
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <div className="flex w-full flex-col gap-2 rounded-(--composer-radius) bg-(--composer-bg) p-2 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.04] transition-[box-shadow,ring-color] focus-within:ring-ring focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.16)] dark:shadow-none dark:ring-white/[0.06]">
        <ComposerPrimitive.Input
          placeholder="输入消息…"
          className="max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/80"
          rows={1}
          autoFocus
          enterKeyHint="send"
          aria-label="消息"
        />
        <ComposerAction />
      </div>
      <p className="mt-1.5 px-2 text-[10px] text-muted-foreground">Enter 发送，Shift+Enter 换行</p>
    </ComposerPrimitive.Root>
  );
}

function ComposerAction() {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <AuiIf condition={(state) => !state.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton tooltip="发送消息" side="top" variant="default" size="icon-sm" className="size-7 rounded-full" aria-label="发送消息">
            <ArrowUpIcon className="size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(state) => state.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button variant="default" size="icon-sm" className="size-7 rounded-full" aria-label="停止生成">
            <SquareIcon className="size-3.5 fill-current" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
}

function MessageError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive dark:bg-destructive/5">
        <ErrorPrimitive.Message className="line-clamp-3" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}

function AssistantMessage() {
  const { ToolFallback: Fallback = ToolFallback, ToolGroup, ReasoningGroup } = useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Root data-slot="aui_assistant-message-root" data-role="assistant" className="relative -mb-7 pb-7 [contain-intrinsic-size:auto_200px] [content-visibility:auto]">
      <div data-slot="aui_assistant-message-content" className="px-2 leading-relaxed text-foreground wrap-break-word">
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": []
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought": return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                return ToolGroup ? <ToolGroup group={part}>{children}</ToolGroup> : (
                  <ToolGroupRoot variant="ghost"><ToolGroupTrigger count={part.indices.length} active={part.status.type === "running"} /><ToolGroupContent>{children}</ToolGroupContent></ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
                const running = part.status.type === "running";
                return <ReasoningRoot streaming={running} variant="ghost"><ReasoningTrigger active={running} /><ReasoningContent aria-busy={running}><ReasoningText>{children}</ReasoningText></ReasoningContent></ReasoningRoot>;
              }
              case "text": return <MarkdownText />;
              case "reasoning": return <Reasoning {...part} />;
              case "tool-call": return part.toolUI ?? <Fallback {...part} />;
              case "data": return part.dataRendererUI;
              case "indicator": return <span className="animate-pulse font-sans" aria-label="助手正在处理">●</span>;
              default: return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>
      <div className="ms-2 flex min-h-7 items-center pt-1">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantActionBar() {
  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="-ms-1 flex gap-1 text-muted-foreground">
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制"><AuiIf condition={(state) => state.message.isCopied}><CheckIcon /></AuiIf><AuiIf condition={(state) => !state.message.isCopied}><CopyIcon /></AuiIf></TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild><TooltipIconButton tooltip="重新生成"><RefreshCwIcon /></TooltipIconButton></ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild><TooltipIconButton tooltip="更多" className="data-[state=open]:bg-accent"><MoreHorizontalIcon /></TooltipIconButton></ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content side="bottom" align="start" sideOffset={6} className="z-[100] min-w-36 overflow-hidden rounded-xl bg-popover/95 p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/[0.04] backdrop-blur-sm dark:ring-white/[0.06]">
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent"><DownloadIcon className="size-4" />导出 Markdown</ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root data-slot="aui_user-message-root" data-role="user" className="grid auto-rows-auto grid-cols-[minmax(56px,1fr)_auto] content-start gap-y-2 px-2 [contain-intrinsic-size:auto_160px] [content-visibility:auto] [&:where(>*)]:col-start-2">
      <UserMessageAttachments />
      <div className="relative col-start-2 min-w-0">
        <div className="peer rounded-xl bg-muted px-4 py-2 text-sm text-foreground wrap-break-word empty:hidden"><MessagePrimitive.Parts /></div>
        <div className="absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden"><UserActionBar /></div>
      </div>
      <BranchPicker className="col-span-full col-start-1 row-start-3 -me-1 justify-end" />
    </MessagePrimitive.Root>
  );
}

function UserActionBar() {
  return <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex flex-col items-end"><ActionBarPrimitive.Edit asChild><TooltipIconButton tooltip="编辑"><PencilIcon /></TooltipIconButton></ActionBarPrimitive.Edit></ActionBarPrimitive.Root>;
}

function EditComposer() {
  return (
    <MessagePrimitive.Root className="flex flex-col px-2">
      <ComposerPrimitive.Root className="ms-auto flex w-full max-w-[88%] flex-col rounded-(--composer-radius) bg-(--composer-bg) shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
        <ComposerPrimitive.Input className="min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground outline-none" autoFocus />
        <div className="mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild><Button variant="ghost" size="sm" className="rounded-full">取消</Button></ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild><Button size="sm" className="rounded-full">更新</Button></ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function BranchPicker({ className, ...rest }: BranchPickerPrimitive.Root.Props) {
  return (
    <BranchPickerPrimitive.Root hideWhenSingleBranch className={cn("-ms-2 me-2 inline-flex items-center text-xs text-muted-foreground", className)} {...rest}>
      <BranchPickerPrimitive.Previous asChild><TooltipIconButton tooltip="上一分支"><ChevronLeftIcon /></TooltipIconButton></BranchPickerPrimitive.Previous>
      <span className="font-medium"><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span>
      <BranchPickerPrimitive.Next asChild><TooltipIconButton tooltip="下一分支"><ChevronRightIcon /></TooltipIconButton></BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}
