import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { IconClose } from "./icons";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "subtle";
  icon?: ReactNode;
};

export function Btn({ variant = "default", icon, children, className = "", type = "button", ...rest }: BtnProps) {
  const iconOnly = icon && children === undefined;
  return (
    <button type={type} className={`btn btn-${variant}${iconOnly ? " btn-icon" : ""}${className ? ` ${className}` : ""}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export type BadgeTone = "muted" | "ok" | "warn" | "bad" | "accent";

export function Badge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Dot({ state, title }: { state: string; title?: string }) {
  return <span className={`dot dot-${state}`} title={title} aria-hidden="true" />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function Modal({ open, onClose, title, width = 560, children, footer }: {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <Btn variant="subtle" icon={<IconClose size={14} />} aria-label="关闭" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
