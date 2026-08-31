import { cn } from "./cn";

export function Skeleton({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function Spinner({ label, size = "default", className }: { label?: string | undefined; size?: "sm" | "default" | "lg" | undefined; className?: string | undefined }) {
  const sizeClass = size === "sm" ? "size-3 border-[1.5px]" : size === "lg" ? "size-6 border-[2.5px]" : "size-4 border-2";
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-muted-foreground", className)}>
      <span className={cn("animate-spin rounded-full border-foreground/15 border-t-ring", sizeClass)} aria-hidden="true" />
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
