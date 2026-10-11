import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
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
