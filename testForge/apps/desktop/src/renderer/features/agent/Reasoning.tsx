import {
  type ReasoningMessagePartComponent,
  useScrollLock
} from "@assistant-ui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import { MarkdownText } from "./MarkdownText";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsibleContent = CollapsiblePrimitive.Content;
import { cn } from "../../shared/ui/index.js";

const ANIMATION_DURATION = 160;

const reasoningVariants = cva("aui-reasoning-root mb-4 w-full", {
  variants: {
    variant: {
      outline: "rounded-xl bg-card px-3 py-2 shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]",
      ghost: "",
      muted: "rounded-xl bg-muted/50 px-3 py-2"
    }
  },
  defaultVariants: { variant: "outline" }
});

export type ReasoningRootProps = Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> &
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
    <Collapsible
      ref={rootRef}
      open={open}
      onOpenChange={change}
      data-slot="reasoning-root"
      data-variant={variant ?? "outline"}
      className={cn("group/reasoning-root", reasoningVariants({ variant }), className)}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

export function ReasoningTrigger({
  active = false,
  duration,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & { active?: boolean; duration?: number }) {
  const label = active ? "正在思考" : "思考过程";
  const durationText = duration ? `（${duration} 秒）` : "";
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex max-w-[85%] origin-left items-center gap-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
        className
      )}
      {...props}
    >
      <BrainIcon className="size-4 shrink-0" />
      <span className="relative inline-block leading-none tabular-nums">
        <span>{label}{durationText}</span>
        {active && <span aria-hidden className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none">{label}{durationText}</span>}
      </span>
      <ChevronDownIcon className="size-4 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
    </CollapsibleTrigger>
  );
}

export function ReasoningContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn(
        "overflow-hidden text-sm text-muted-foreground outline-none data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}

export function ReasoningText({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("max-h-64 overflow-y-auto ps-6 pt-2 pb-2 leading-relaxed text-pretty", className)} {...props} />;
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

export const Reasoning = Object.assign(memo(ReasoningImpl), {
  Root: ReasoningRoot,
  Trigger: ReasoningTrigger,
  Content: ReasoningContent,
  Text: ReasoningText
});
