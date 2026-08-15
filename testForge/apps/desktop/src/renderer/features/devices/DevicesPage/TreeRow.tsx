import type { ReactNode } from "react";
import { IconChevron } from "../../../shared/icons.js";
import { Dot } from "../../../shared/ui.js";

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
    className={`tree-row${selected ? " selected" : ""}${className ? ` ${className}` : ""}`}
    style={{ paddingLeft: 12 + depth * 20 }}
    title={title ?? label}
    onClick={onClick}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}
  >
    <span className={`twisty${open ? " open" : ""}`}>{hasChildren ? <IconChevron size={13} /> : null}</span>
    <span className="tree-icon">{icon}</span>
    <span className="tree-label">{label}</span>
    {subtitle && <span className="tree-subtitle">{subtitle}</span>}
    {meta && <span className="tree-count">{meta}</span>}
    {statuses?.map((status) => <span key={status.label} className="row-status-item" title={status.title}>
      <Dot state={status.dot} />
      <span className={`row-status s-${status.dot}`}>{status.label}</span>
    </span>)}
    {actions}
  </div>;
}

export function InlineDetail({ depth, children }: { depth: number; children: ReactNode }) {
  return <div className="inline-detail">
    <div className="inline-clip">
      <div className="inline-body" style={{ marginLeft: 12 + depth * 20 }}>{children}</div>
    </div>
  </div>;
}
