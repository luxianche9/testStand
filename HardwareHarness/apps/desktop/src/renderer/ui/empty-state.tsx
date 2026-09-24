import * as React from "react";
import { cn } from "./cn";

export function EmptyState({ icon, title, description, action, className, compact }: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "px-4 py-6" : "h-full min-h-40 px-6 py-10",
        className
      )}
    >
      {icon && (
        <div
          aria-hidden
          className={cn(
            "mb-1 grid place-items-center rounded-md border border-dashed border-line-strong text-fg-3",
            "[&_svg]:size-4",
            compact ? "size-8" : "size-10"
          )}
        >
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="max-w-80 text-xs leading-5 text-fg-2">{description}</p>}
      {action && <div className="mt-2 flex items-center gap-2">{action}</div>}
    </div>
  );
}
