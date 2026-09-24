import {
  type ReasoningMessagePartComponent,
  useScrollLock
} from "@assistant-ui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "../../ui";
import { MarkdownText } from "./MarkdownText";

const ANIMATION_DURATION = 160;

const reasoningVariants = cva("aui-reasoning-root mb-3 w-full", {
  variants: {
    variant: {
      outline: "rounded-md border border-line bg-surface-0/40 px-2 py-1",
      ghost: "",
      muted: "rounded-md bg-surface-2/50 px-2 py-1"
    }
  },
  defaultVariants: { variant: "outline" }
});

export type ReasoningRootProps = Omit<React.ComponentProps<typeof Collapsible.Root>, "open" | "onOpenChange"> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    streaming?: boolean;
  };

export function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  streaming = false,
  children,
  ...props
}: ReasoningRootProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lockScroll = useScrollLock(rootRef, ANIMATION_DURATION);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : (userOpen ?? (streaming || defaultOpen));
  const change = useCallback((next: boolean) => {
    lockScroll();
    if (!controlled) setUserOpen(next);
    onOpenChange?.(next);
  }, [controlled, lockScroll, onOpenChange]);

  return (
    <Collapsible.Root
      ref={rootRef}
      open={open}
      onOpenChange={change}
      data-slot="reasoning-root"
      data-variant={variant ?? "outline"}
      className={cn("group/reasoning-root", reasoningVariants({ variant }), className)}
      {...props}
    >
      {children}
    </Collapsible.Root>
  );
}

export function ReasoningTrigger({
  active = false,
  duration,
  className,
  ...props
}: React.ComponentProps<typeof Collapsible.Trigger> & { active?: boolean; duration?: number }) {
  const label = active ? "正在思考" : "思考过程";
  const durationText = duration ? `（${duration} 秒）` : "";
  return (
    <Collapsible.Trigger
      className={cn(
        "group flex max-w-[85%] items-center gap-1.5 rounded-sm py-1 text-xs text-fg-3 outline-none",
        "transition-colors duration-120 hover:text-fg-2",
        "focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-signal",
        className
      )}
      {...props}
    >
      <BrainIcon aria-hidden className={cn("size-3.5 shrink-0", active && "text-run")} />
      <span className="tf-num relative inline-block leading-none">
        <span>{label}{durationText}</span>
        {active && (
          <span aria-hidden className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none">
            {label}{durationText}
          </span>
        )}
      </span>
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 shrink-0 transition-transform duration-120 group-data-[state=open]:rotate-90"
      />
    </Collapsible.Trigger>
  );
}

export function ReasoningContent({ className, children, ...props }: React.ComponentProps<typeof Collapsible.Content>) {
  return (
    <Collapsible.Content
      className={cn(
        "overflow-hidden text-sm text-fg-2 outline-none",
        "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
        "motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      {children}
    </Collapsible.Content>
  );
}

export function ReasoningText({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("max-h-64 overflow-y-auto border-l border-line py-1.5 ps-3 leading-relaxed text-pretty", className)}
      {...props}
    />
  );
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

export const Reasoning = Object.assign(memo(ReasoningImpl), {
  Root: ReasoningRoot,
  Trigger: ReasoningTrigger,
  Content: ReasoningContent,
  Text: ReasoningText
});
