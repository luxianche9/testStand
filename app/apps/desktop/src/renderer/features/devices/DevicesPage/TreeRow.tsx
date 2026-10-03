import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn, StatusLamp, toneText } from "../../../ui";
import type { RowStatus } from "./device-labels.js";

/** One 24px row of the instrument tree. Rows are flat siblings; depth is carried by aria-level. */
export function TreeRow({
  depth, label, title, meta, status, hasChildren, open, selected, tabbable, onClick, onToggle, actions, className
}: {
  depth: number;
  label: string;
  /** Hover text; carries the identifier, which the row itself does not show. */
  title?: string | undefined;
  meta?: ReactNode;
  status?: RowStatus | undefined;
  hasChildren?: boolean;
  open?: boolean;
  selected: boolean;
  /** Roving tab stop: exactly one row per tree is reachable with Tab. */
  tabbable: boolean;
  onClick: () => void;
  /** Expand/collapse for the chevron and ArrowRight/ArrowLeft; defaults to `onClick`. */
  onToggle?: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
      return;
    }
    if (!hasChildren) return;
    const collapse = event.key === "ArrowLeft" && open;
    const expand = event.key === "ArrowRight" && !open;
    if (collapse || expand) {
      event.preventDefault();
      (onToggle ?? onClick)();
    }
  };
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? Boolean(open) : undefined}
      tabIndex={tabbable ? 0 : -1}
      title={title ?? label}
      className={cn(
        "group/row relative flex h-6 cursor-default items-center gap-1.5 pr-2 text-sm text-fg-2 select-none",
        "outline-none transition-colors duration-120 hover:bg-surface-2 hover:text-fg",
        "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal",
        selected && "bg-surface-2 text-fg before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        selected && "before:bg-signal before:content-['']",
        className
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn("grid size-3.5 flex-none place-items-center text-fg-3", hasChildren && "hover:text-fg")}
        onClick={hasChildren ? (event) => { event.stopPropagation(); (onToggle ?? onClick)(); } : undefined}
      >
        {hasChildren && (
          <ChevronRightIcon className={cn("size-3 transition-transform duration-120", open && "rotate-90")} />
        )}
      </span>
      {status && <StatusLamp tone={status.tone} pulse={status.pulse ?? false} className="size-1.5" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta !== undefined && <span className="tf-num flex-none text-2xs text-fg-3">{meta}</span>}
      {status && (
        <span title={status.title} className={cn("flex-none text-2xs", toneText[status.tone])}>{status.label}</span>
      )}
      {actions && (
        <span className="flex flex-none items-center" onClick={(event) => event.stopPropagation()}>{actions}</span>
      )}
    </div>
  );
}

/** Placeholder line inside a tree branch ("no devices yet"). */
export function TreeNote({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <p className="py-1 pr-3 text-xs leading-5 text-fg-3" style={{ paddingLeft: 26 + depth * 14 }}>{children}</p>
  );
}

/** Arrow/Home/End focus movement across the visible rows of one tree. */
export function onTreeKeyDown(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='treeitem']")];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  const next = event.key === "ArrowDown" ? index + 1
    : event.key === "ArrowUp" ? index - 1
      : event.key === "Home" ? 0 : items.length - 1;
  const target = items[Math.max(0, Math.min(items.length - 1, next))];
  if (!target) return;
  event.preventDefault();
  target.focus();
}
