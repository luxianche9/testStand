import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "../../../shared/ui/cn";
import { Dot } from "../../../shared/ui/skeleton";

export function TreeRow({ depth, icon, label, subtitle, title, meta, statuses, hasChildren, open, selected, onClick, actions, className = "" }: {
  depth: number;
  icon: ReactNode;
  label: string;
  subtitle?: string | undefined;
  title?: string | undefined;
  meta?: string | undefined;
  statuses?: { dot: string; label: string; title?: string | undefined }[];
  hasChildren?: boolean;
  open?: boolean;
  selected: boolean;
  onClick: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  return <div
    role="treeitem"
    aria-level={depth + 1}
    tabIndex={0}
    aria-selected={selected}
    aria-expanded={hasChildren ? Boolean(open) : undefined}
    className={cn(
      "flex h-9 w-full cursor-pointer items-center gap-2 pr-3 text-[13px] transition-[color,background-color] duration-150 ease-[var(--tf-ease-out)] select-none hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45",
      selected && "bg-accent font-medium",
      className
    )}
    style={{ paddingLeft: 12 + depth * 20 }}
    title={title ?? label}
    onClick={onClick}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}
  >
    <span className="grid size-4 flex-none place-items-center text-muted-foreground/60">{hasChildren ? <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} /> : null}</span>
    <span className={cn("grid flex-none place-items-center text-muted-foreground", selected && "text-primary")}>{icon}</span>
    <span className="flex-1 truncate">{label}</span>
    {subtitle && <span className="max-w-[220px] truncate text-[10px] text-muted-foreground/70">{subtitle}</span>}
    {meta && <span className="min-w-[18px] flex-none rounded-full bg-foreground/8 px-1.5 text-center text-[11px] leading-[18px] text-muted-foreground">{meta}</span>}
    {statuses?.map((status) => <span key={status.label} className="flex flex-none items-center gap-1.5" title={status.title}>
      <Dot state={status.dot} />
      <span className={cn(
        "flex-none text-xs",
        status.dot === "ok" && "text-success",
        status.dot === "warn" && "text-warning",
        status.dot === "bad" && "text-destructive",
        status.dot === "checking" && "text-primary",
        (status.dot === "muted" || !["ok", "warn", "bad", "checking"].includes(status.dot)) && "text-muted-foreground/70"
      )}>{status.label}</span>
    </span>)}
    {actions}
  </div>;
}

export function InlineDetail({ depth, children }: { depth: number; children: ReactNode }) {
  return <div className="animate-collapsible-down bg-secondary/50">
    <div className="min-h-0 overflow-hidden">
      <div className="py-3.5 pr-5 pl-5" style={{ marginLeft: 12 + depth * 20 }}>{children}</div>
    </div>
  </div>;
}
