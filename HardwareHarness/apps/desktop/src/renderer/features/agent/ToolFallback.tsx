import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartStatus,
  useScrollLock,
  useToolCallElapsed
} from "@assistant-ui/react";
import { ChevronRightIcon } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "../../ui";
import { ToolFallbackApproval } from "./ToolApproval";
import {
  isCancelledToolStatus,
  toolBodyClass,
  toolCardClass,
  ToolLamp,
  toolPreClass,
  toolRowClass
} from "./tools/shared";
import { formatUnknown } from "./utils";

export { ToolFallbackApproval } from "./ToolApproval";

const ANIMATION_DURATION = 160;

export function ToolFallbackRoot({
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible.Root>, "open" | "onOpenChange"> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(rootRef, ANIMATION_DURATION);
  const controlled = controlledOpen !== undefined;
  const change = useCallback((next: boolean) => {
    lockScroll();
    if (!controlled) setLocalOpen(next);
    onOpenChange?.(next);
  }, [controlled, lockScroll, onOpenChange]);
  return (
    <Collapsible.Root
      ref={rootRef}
      open={controlled ? controlledOpen : localOpen}
      onOpenChange={change}
      className={cn("group/tool-fallback-root", toolCardClass, className)}
      {...props}
    >
      {children}
    </Collapsible.Root>
  );
}

function formatDuration(ms: number) {
  if (ms < 1000) return "<1 秒";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)} 秒`;
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}

function ToolDuration() {
  const elapsed = useToolCallElapsed();
  if (elapsed === undefined) return null;
  return <span className="tf-num shrink-0 text-2xs text-fg-3">{formatDuration(elapsed)}</span>;
}

function statusLabel(status?: ToolCallMessagePartStatus) {
  const type = status?.type ?? "complete";
  if (type === "requires-action") return "等待确认";
  if (type === "running") return "正在调用";
  if (isCancelledToolStatus(status)) return "已取消";
  return type === "incomplete" ? "调用失败" : "已调用";
}

export function ToolFallbackTrigger({
  toolName,
  status,
  className,
  ...props
}: React.ComponentProps<typeof Collapsible.Trigger> & { toolName: string; status?: ToolCallMessagePartStatus }) {
  const running = status?.type === "running";
  const cancelled = isCancelledToolStatus(status);
  const label = statusLabel(status);
  return (
    <Collapsible.Trigger className={cn("group", toolRowClass, className)} {...props}>
      <ToolLamp status={status} />
      <span className={cn("relative min-w-0 flex-1 truncate", cancelled && "line-through opacity-50")}>
        <span>
          {label}：<b className="font-mono font-medium text-fg">{toolName}</b>
        </span>
        {running && (
          <span aria-hidden className="shimmer pointer-events-none absolute inset-0">
            {label}：<b className="font-mono font-medium">{toolName}</b>
          </span>
        )}
      </span>
      <ToolDuration />
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 shrink-0 text-fg-3 transition-transform duration-120 group-data-[state=open]:rotate-90"
      />
    </Collapsible.Trigger>
  );
}

export function ToolFallbackContent(
  { className, children, ...props }: React.ComponentProps<typeof Collapsible.Content>
) {
  return (
    <Collapsible.Content className={cn(toolBodyClass, "text-sm outline-none", className)} {...props}>
      <div className="flex flex-col gap-2 p-2">{children}</div>
    </Collapsible.Content>
  );
}

export function ToolFallbackArgs({ argsText }: { argsText?: string }) {
  if (!argsText) return null;
  return (
    <div className="grid gap-1">
      <p className="tf-label">参数</p>
      <pre className={toolPreClass}>{argsText}</pre>
    </div>
  );
}

export function ToolFallbackResult({ result }: { result?: unknown }) {
  if (result === undefined) return null;
  return (
    <div className="grid gap-1">
      <p className="tf-label">结果</p>
      <pre className={cn(toolPreClass, "max-h-72")}>{formatUnknown(result)}</pre>
    </div>
  );
}

export function ToolFallbackError({ status }: { status?: ToolCallMessagePartStatus }) {
  if (status?.type !== "incomplete" || !status.error) return null;
  const cancelled = status.reason === "cancelled";
  return (
    <div
      className={cn(
        "rounded-sm border p-2 text-xs",
        cancelled ? "border-line bg-surface-2 text-fg-2" : "border-fail/35 bg-fail/8 text-fail"
      )}
    >
      <strong className="font-medium">{cancelled ? "取消原因" : "错误"}</strong>
      <p className="mt-1 font-mono whitespace-pre-wrap wrap-break-word">{formatUnknown(status.error)}</p>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval
}) => {
  const requiresAction = status?.type === "requires-action";
  const [open, setOpen] = useState(requiresAction);
  return (
    <ToolFallbackRoot open={open || requiresAction} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs argsText={argsText} />
        {requiresAction && <ToolFallbackApproval {...{ addResult, resume, interrupt, approval, respondToApproval }} />}
        <ToolFallbackResult result={result} />
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

export const ToolFallback = Object.assign(memo(ToolFallbackImpl), {
  Root: ToolFallbackRoot,
  Trigger: ToolFallbackTrigger,
  Content: ToolFallbackContent,
  Args: ToolFallbackArgs,
  Result: ToolFallbackResult,
  Error: ToolFallbackError,
  Approval: ToolFallbackApproval
}) as typeof ToolFallbackImpl & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};
