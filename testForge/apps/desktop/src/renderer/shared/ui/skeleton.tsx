import { cn } from "./cn";

export function Skeleton({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-muted-foreground", className)}>
      <span className="size-4 animate-spin rounded-full border-2 border-foreground/15 border-t-ring" aria-hidden="true" />
      {label && <span className="text-sm">{label}</span>}
    </span>
  );
}

/** 状态点:ok/warn/bad/muted/checking(带脉冲)。 */
export function Dot({ state, title, className }: { state: string; title?: string; className?: string }) {
  return (
    <span
      title={title}
      aria-hidden="true"
      className={cn(
        "size-2 flex-none rounded-full bg-muted-foreground/50",
        state === "ok" && "bg-success",
        state === "warn" && "bg-warning",
        state === "bad" && "bg-destructive",
        state === "checking" && "animate-pulse bg-ring",
        className
      )}
    />
  );
}
