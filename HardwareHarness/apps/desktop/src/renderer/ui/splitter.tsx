import * as React from "react";
import { cn } from "./cn";

/**
 * Vertical resize handle. Spread `useResizableWidth().separatorProps` into it.
 * It sits in its own 1px grid track; the hit area extends 3px each side.
 */
export const Splitter = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<"div"> & { label: string }>(
  function Splitter({ label, className, ...props }, ref) {
    return (
      <div
        ref={ref}
        aria-label={label}
        title="拖动调整宽度，双击恢复默认宽度"
        className={cn(
          "group relative z-10 w-px shrink-0 cursor-col-resize bg-line outline-none",
          "before:absolute before:inset-y-0 before:-right-[3px] before:-left-[3px] before:content-['']",
          "after:absolute after:inset-y-0 after:left-0 after:w-px after:bg-signal after:opacity-0",
          "after:transition-opacity after:duration-120 after:content-['']",
          "hover:after:opacity-70 focus-visible:after:opacity-100 data-[dragging=true]:after:opacity-100",
          className
        )}
        {...props}
      />
    );
  }
);
