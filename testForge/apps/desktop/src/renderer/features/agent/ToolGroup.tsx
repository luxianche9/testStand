import { useScrollLock } from "@assistant-ui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDownIcon, LoaderIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsibleContent = CollapsiblePrimitive.Content;
import { cn } from "../../shared/ui/index.js";

const ANIMATION_DURATION = 160;
const variants = cva("group/tool-group-root w-full", {
  variants: {
    variant: {
      outline: "rounded-lg border py-3",
      ghost: "",
      muted: "rounded-lg border border-muted-foreground/30 bg-muted/30 py-3"
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
}: Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> &
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
    <Collapsible
      ref={rootRef}
      open={controlled ? controlledOpen : localOpen}
      onOpenChange={change}
      data-variant={variant ?? "outline"}
      className={cn(variants({ variant }), className)}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

export function ToolGroupTrigger({
  count,
  active = false,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & { count: number; active?: boolean }) {
  const label = `${count} 次工具调用`;
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex origin-left items-center gap-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 group-data-[variant=outline]/tool-group-root:w-full group-data-[variant=outline]/tool-group-root:px-4",
        className
      )}
      {...props}
    >
      {active && <LoaderIcon className="size-3 shrink-0 animate-spin" />}
      <span className="relative grow text-start text-xs leading-none font-medium">
        <span>{label}</span>
        {active && <span aria-hidden className="shimmer pointer-events-none absolute inset-0">{label}</span>}
      </span>
      <ChevronDownIcon className="size-3 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
    </CollapsibleTrigger>
  );
}

export function ToolGroupContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn("overflow-hidden text-sm outline-none data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none", className)}
      {...props}
    >
      <div className="mt-1 flex flex-col gap-1 group-data-[variant=outline]/tool-group-root:mt-3 group-data-[variant=outline]/tool-group-root:border-t group-data-[variant=outline]/tool-group-root:px-4 group-data-[variant=outline]/tool-group-root:pt-3">
        {children}
      </div>
    </CollapsibleContent>
  );
}
