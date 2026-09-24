import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ content, side = "bottom", children }: {
  content: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={100}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className={
              "z-[120] animate-fade-in rounded-sm border border-line-strong bg-surface-3 px-2 py-1 " +
              "text-xs text-fg shadow-overlay"
            }
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
