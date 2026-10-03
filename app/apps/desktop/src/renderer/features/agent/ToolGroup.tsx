import { useScrollLock } from "@assistant-ui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Collapsible } from "radix-ui";
import { cn, StatusLamp } from "../../ui";

const ANIMATION_DURATION = 160;
const variants = cva("group/tool-group-root w-full min-w-0", {
  variants: {
    variant: {
      outline: "overflow-hidden rounded-md border border-line bg-surface-0/40",
      ghost: "",
      muted: "overflow-hidden rounded-md border border-line bg-surface-2/50"
    }
  },
  defaultVariants: { variant: "outline" }
});

export function ToolGroupRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible.Root>, "open" | "onOpenChange"> &
  VariantProps<typeof variants> & { open?: boolean; onOpenChange?: (open: boolean) => void; defaultOpen?: boolean }) {
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
      data-variant={variant ?? "outline"}
      className={cn(variants({ variant }), className)}
      {...props}
    >
      {children}
    </Collapsible.Root>
  );
}

export function ToolGroupTrigger({
  count,
  active = false,
  className,
  ...props
}: React.ComponentProps<typeof Collapsible.Trigger> & { count: number; active?: boolean }) {
  const label = `${count} 次工具调用`;
  return (
    <Collapsible.Trigger
      className={cn(
        "group flex h-7 w-full items-center gap-2 px-2 text-xs text-fg-2 outline-none",
        "transition-colors duration-120 hover:bg-surface-2 hover:text-fg",
        "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal",
        className
      )}
      {...props}
    >
      <StatusLamp tone={active ? "run" : "neutral"} pulse={active} />
      <span className="tf-num relative grow text-start font-medium">
        <span>{label}</span>
        {active && <span aria-hidden className="shimmer pointer-events-none absolute inset-0">{label}</span>}
      </span>
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 shrink-0 text-fg-3 transition-transform duration-120 group-data-[state=open]:rotate-90"
      />
    </Collapsible.Trigger>
  );
}

export function ToolGroupContent({ className, children, ...props }: React.ComponentProps<typeof Collapsible.Content>) {
  return (
    <Collapsible.Content
      className={cn(
        "overflow-hidden text-sm outline-none",
        "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
        "motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "flex flex-col gap-1.5 pt-1.5",
          "group-data-[variant=outline]/tool-group-root:border-t",
          "group-data-[variant=outline]/tool-group-root:border-line",
          "group-data-[variant=outline]/tool-group-root:p-1.5"
        )}
      >
        {children}
      </div>
    </Collapsible.Content>
  );
}
