import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive
} from "@assistant-ui/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  RefreshCwIcon
} from "lucide-react";
import { useContext } from "react";
import { cn, IconButton } from "../../ui";
import { MarkdownText } from "./MarkdownText";
import { Reasoning, ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "./Reasoning";
import { ThreadComponentsContext } from "./thread-context";
import { ToolFallback } from "./ToolFallback";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "./ToolGroup";

const groupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": []
});

function MessageError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="mt-2 rounded-sm border border-fail/40 bg-fail/8 px-2.5 py-2 text-xs text-fail">
        <ErrorPrimitive.Message className="line-clamp-3 font-mono" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}

export function AssistantMessage() {
  const { ToolFallback: Fallback = ToolFallback, ToolGroup, ReasoningGroup } = useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative -mb-7 pb-7 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="grid gap-1.5 text-sm leading-relaxed text-fg wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought": return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) return <ToolGroup group={part}>{children}</ToolGroup>;
                return (
                  <ToolGroupRoot variant="outline">
                    <ToolGroupTrigger count={part.indices.length} active={part.status.type === "running"} />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running} variant="ghost">
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}><ReasoningText>{children}</ReasoningText></ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text": return <MarkdownText />;
              case "reasoning": return <Reasoning {...part} />;
              case "tool-call": return part.toolUI ?? <Fallback {...part} />;
              case "data": return part.dataRendererUI;
              case "indicator":
                return <span aria-label="助手正在处理" className="inline-block size-2 animate-lamp rounded-full bg-run" />;
              default: return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>
      <div className="flex min-h-7 items-center pt-1">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
}

const moreItemClass = cn(
  "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-none select-none",
  "data-[highlighted]:bg-surface-2 [&_svg]:size-3.5 [&_svg]:text-fg-3"
);

function AssistantActionBar() {
  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="-ms-1 flex gap-0.5 text-fg-3">
      <ActionBarPrimitive.Copy asChild>
        <IconButton label="复制" size="icon-sm">
          <AuiIf condition={(state) => state.message.isCopied}><CheckIcon className="text-pass" /></AuiIf>
          <AuiIf condition={(state) => !state.message.isCopied}><CopyIcon /></AuiIf>
        </IconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <IconButton label="重新生成" size="icon-sm"><RefreshCwIcon /></IconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <IconButton label="更多" size="icon-sm" className="data-[state=open]:bg-surface-2">
            <MoreHorizontalIcon />
          </IconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className={
            "z-[110] min-w-36 animate-fade-in overflow-hidden rounded-md border border-line-strong " +
            "bg-surface-3 p-1 text-fg shadow-overlay"
          }
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className={moreItemClass}>
              <DownloadIcon />导出 Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
}

export function BranchPicker({ className, ...rest }: BranchPickerPrimitive.Root.Props) {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn("-ms-1 me-2 inline-flex items-center text-xs text-fg-3", className)}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <IconButton label="上一分支" size="icon-sm"><ChevronLeftIcon /></IconButton>
      </BranchPickerPrimitive.Previous>
      <span className="tf-num">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <IconButton label="下一分支" size="icon-sm"><ChevronRightIcon /></IconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}
