import * as React from "react";
import { cn } from "./cn";

/**
 * Resize handle. Spread `useResizableWidth().separatorProps` into it; a horizontal separator
 * (from an "up" / "down" resizable) lays out as a row. It sits in its own 1px grid track; the hit
 * area extends 3px each side.
 */
export const Splitter = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<"div"> & { label: string }>(
  function Splitter({ label, className, ...props }, ref) {
    const row = props["aria-orientation"] === "horizontal";
    return (
      <div
        ref={ref}
        aria-label={label}
        title={row ? "拖动调整高度，双击恢复默认高度" : "拖动调整宽度，双击恢复默认宽度"}
        className={cn(
          "group relative z-10 shrink-0 bg-line outline-none",
          row
            ? cn("h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-[3px] before:-bottom-[3px]",
              "after:absolute after:inset-x-0 after:top-0 after:h-px")
            : cn("w-px cursor-col-resize before:absolute before:inset-y-0 before:-right-[3px] before:-left-[3px]",
              "after:absolute after:inset-y-0 after:left-0 after:w-px"),
          "before:content-[''] after:bg-signal after:opacity-0",
          "after:transition-opacity after:duration-120 after:content-['']",
          "hover:after:opacity-70 focus-visible:after:opacity-100 data-[dragging=true]:after:opacity-100",
          className
        )}
        {...props}
      />
    );
  }
);
