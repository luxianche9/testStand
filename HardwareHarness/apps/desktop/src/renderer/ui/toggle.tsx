import * as React from "react";
import { Checkbox as CheckboxPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "./cn";

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-xs border border-fg-3/70 bg-surface-0",
        "transition-colors duration-120 hover:border-fg-2 disabled:opacity-45",
        "data-[state=checked]:border-signal data-[state=checked]:bg-signal data-[state=checked]:text-signal-fg",
        "data-[state=indeterminate]:border-signal data-[state=indeterminate]:text-signal",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {props.checked === "indeterminate" ? (
          <MinusIcon className="size-2.5" strokeWidth={3} />
        ) : (
          <CheckIcon className="size-2.5" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-line-strong bg-surface-3",
        "transition-colors duration-120 disabled:opacity-45",
        "data-[state=checked]:border-signal data-[state=checked]:bg-signal",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block size-3 translate-x-0.5 rounded-full bg-fg-2 transition-transform duration-120",
          "data-[state=checked]:translate-x-3 data-[state=checked]:bg-signal-fg"
        )}
      />
    </SwitchPrimitive.Root>
  );
});
