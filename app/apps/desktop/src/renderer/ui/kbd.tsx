import * as React from "react";
import { cn } from "./cn";

export function Kbd({ className, ...props }: React.ComponentPropsWithoutRef<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line-strong",
        "bg-surface-0 px-1 font-mono text-2xs leading-none text-fg-2",
        className
      )}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div aria-hidden className={cn("animate-pulse rounded-sm bg-surface-2", className)} {...props} />;
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent",
        className
      )}
    />
  );
}
