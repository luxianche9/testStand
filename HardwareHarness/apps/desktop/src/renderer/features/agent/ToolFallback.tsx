import {
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  useScrollLock,
  useToolCallElapsed
} from "@assistant-ui/react";
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { Button } from "../../shared/ui/index.js";
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsibleContent = CollapsiblePrimitive.Content;
import { cn } from "../../shared/ui/index.js";
import { formatUnknown } from "./utils";

const ANIMATION_DURATION = 160;
const APPROVED_RESULT = "Approved by user";
const DENIED_RESULT = "User denied tool execution";

const statusIcons: Record<ToolCallMessagePartStatus["type"], React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon
};

export function ToolFallbackRoot({
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
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
    <Collapsible
      ref={rootRef}
      open={controlled ? controlledOpen : localOpen}
      onOpenChange={change}
      className={cn("group/tool-fallback-root w-full", className)}
      {...props}
    >
      {children}
    </Collapsible>
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
  return elapsed === undefined ? null : <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(elapsed)}</span>;
}

export function ToolFallbackTrigger({
  toolName,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & { toolName: string; status?: ToolCallMessagePartStatus }) {
  const type = status?.type ?? "complete";
  const Icon = statusIcons[type];
  const running = type === "running";
  const cancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const label = type === "requires-action" ? "等待确认" : running ? "正在调用" : cancelled ? "已取消" : type === "incomplete" ? "调用失败" : "已调用";
  return (
    <CollapsibleTrigger
      className={cn("group flex w-fit max-w-full items-center gap-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40", className)}
      {...props}
    >
      <Icon className={cn("size-4 shrink-0", running && "animate-spin", type === "incomplete" && !cancelled && "text-destructive")} />
      <span className={cn("relative min-w-0 truncate leading-none", cancelled && "line-through opacity-60")}>
        <span>{label}：<b>{toolName}</b></span>
        {running && <span aria-hidden className="shimmer pointer-events-none absolute inset-0">{label}：<b>{toolName}</b></span>}
      </span>
      <ToolDuration />
      <ChevronDownIcon className="size-4 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
    </CollapsibleTrigger>
  );
}

export function ToolFallbackContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn("overflow-hidden text-sm outline-none data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none", className)}
      {...props}
    >
      <div className="flex flex-col gap-2 ps-6 pt-1 pb-2">{children}</div>
    </CollapsibleContent>
  );
}

export function ToolFallbackArgs({ argsText }: { argsText?: string }) {
  if (!argsText) return null;
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2.5 font-mono text-xs text-foreground/90">{argsText}</pre>;
}

export function ToolFallbackResult({ result }: { result?: unknown }) {
  if (result === undefined) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">结果</p>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2.5 font-mono text-xs text-foreground/90">{formatUnknown(result)}</pre>
    </div>
  );
}

export function ToolFallbackError({ status }: { status?: ToolCallMessagePartStatus }) {
  if (status?.type !== "incomplete" || !status.error) return null;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
      <strong>{status.reason === "cancelled" ? "取消原因" : "错误"}</strong>
      <p className="mt-1 whitespace-pre-wrap">{formatUnknown(status.error)}</p>
    </div>
  );
}

const optionLabels: Record<string, string> = {
  "allow-once": "允许一次",
  "allow-always": "始终允许",
  "reject-once": "拒绝",
  "reject-always": "始终拒绝"
};
const isAllow = (kind: string) => kind === "allow-once" || kind === "allow-always";
const optionLabel = (option: ToolApprovalOption) => option.label ?? optionLabels[option.kind] ?? option.id;

export function ToolFallbackApproval({
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval
}: Partial<Pick<ToolCallMessagePartProps, "addResult" | "resume" | "respondToApproval">> & {
  interrupt?: ToolCallMessagePart["interrupt"];
  approval?: ToolCallMessagePart["approval"];
}) {
  const [submitted, setSubmitted] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  if (approval && (approval.approved !== undefined || approval.resolution !== undefined)) return null;
  const declared = respondToApproval ? approval?.options : undefined;
  const options = declared?.filter((option) => option.kind in optionLabels) ?? [];

  const respond = (approved: boolean) => {
    if (submitted) return;
    if (approval && approval.approved === undefined && respondToApproval) respondToApproval({ approved });
    else if (interrupt) resume?.({ approved });
    else addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
    setSubmitted(true);
  };
  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return;
    respondToApproval?.({ optionId: option.id });
    setSubmitted(true);
    setConfirmingId(null);
  };
  const confirming = options.find((option) => option.id === confirmingId);
  if (confirming) {
    const meta = typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    return (
      <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="font-semibold">{meta?.title ?? `确认“${optionLabel(confirming)}”？`}</p>
        {(meta?.description ?? confirming.description) && <p className="text-xs text-muted-foreground">{meta?.description ?? confirming.description}</p>}
        {confirming.grants?.map((grant) => <code key={grant} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">{grant}</code>)}
        <div className="flex gap-2">
          <Button size="sm" disabled={submitted} onClick={() => respondWithOption(confirming)}>确认</Button>
          <Button size="sm" variant="outline" disabled={submitted} onClick={() => setConfirmingId(null)}>返回</Button>
        </div>
      </div>
    );
  }

  if (declared?.length) {
    const allow = options.filter((option) => isAllow(option.kind));
    const reject = options.filter((option) => !isAllow(option.kind));
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        {[...allow, ...reject].map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option === allow[0] ? "default" : "outline"}
            disabled={submitted}
            onClick={() => option.confirm ? setConfirmingId(option.id) : respondWithOption(option)}
          >
            {optionLabel(option)}
          </Button>
        ))}
        {!reject.length && <Button size="sm" variant="outline" disabled={submitted} onClick={() => respond(false)}>拒绝</Button>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <Button size="sm" disabled={submitted} onClick={() => respond(true)}>允许</Button>
      <Button size="sm" variant="outline" disabled={submitted} onClick={() => respond(false)}>拒绝</Button>
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
