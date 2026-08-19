import * as React from "react";
import { Checkbox as CheckboxPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";
import { cn } from "./cn";
import { Button, type ButtonProps } from "./button";

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "peer size-4 shrink-0 rounded-sm border border-input bg-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center text-current">
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ content, side = "bottom", children }: {
  content: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={5}
            className="z-[120] animate-fade-in rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-foreground" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export type TooltipIconButtonProps = ButtonProps & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = React.forwardRef<HTMLButtonElement, TooltipIconButtonProps>(function TooltipIconButton(
  { children, tooltip, side = "bottom", className, ...rest }, ref
) {
  return (
    <Tooltip content={tooltip} side={side}>
      <Button variant="ghost" size="icon-xs" {...rest} className={cn("active:scale-95", className)} ref={ref}>
        {children}
        <span className="sr-only">{tooltip}</span>
      </Button>
    </Tooltip>
  );
});
