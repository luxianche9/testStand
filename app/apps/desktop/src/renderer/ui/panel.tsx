import * as React from "react";
import { cn } from "./cn";

/** A framed region of the console. Use `as="section"` with aria-label for landmarks. */
export function Panel({ as: Comp = "div", className, ...props }: React.HTMLAttributes<HTMLElement> & {
  as?: "div" | "section" | "aside" | "nav" | "main";
}) {
  return <Comp className={cn("flex min-h-0 min-w-0 flex-col bg-surface-1", className)} {...props} />;
}

/** Nameplate header: uppercase mono title on the left, actions on the right. */
export function PanelHeader({ title, meta, actions, className, children }: {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-line px-3", className)}>
      {title && <h2 className="tf-label min-w-0 truncate text-fg-2">{title}</h2>}
      {meta && <span className="tf-num truncate text-xs text-fg-3">{meta}</span>}
      {children}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

export function PanelBody({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-auto", className)} {...props} />;
}

/** Horizontal strip of controls (page command bars, canvas toolbars). */
export function Toolbar({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      role="toolbar"
      className={cn("flex h-10 shrink-0 items-center gap-1.5 border-b border-line bg-surface-1 px-3", className)}
      {...props}
    />
  );
}

export function ToolbarDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-1 h-4 w-px bg-line", className)} />;
}

/** Inspector section: label rule then content. */
export function Section({ title, actions, className, children }: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("grid gap-2 border-b border-line px-3 py-3 last:border-b-0", className)}>
      <div className="flex min-h-5 items-center gap-2">
        <h3 className="tf-label min-w-0 flex-1 truncate">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
