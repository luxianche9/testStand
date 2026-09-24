import type { ReactNode } from "react";
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, InfoIcon } from "lucide-react";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, PanelHeader, cn } from "../../ui";

/** Title block of one settings page; the h1 is what e2e and screen readers land on. */
export function SettingsHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <header className="mb-5 grid gap-1.5 border-b border-line pb-4">
      <h1 className="text-lg leading-6 font-semibold tracking-tight text-fg">{title}</h1>
      <p className="max-w-[68ch] text-sm leading-5 text-fg-2">{description}</p>
    </header>
  );
}

/** Framed group with an instrument nameplate header. */
export function SettingsCard({ title, meta, actions, footer, className, children }: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("overflow-hidden rounded-md border border-line bg-surface-1", className)}>
      <PanelHeader title={title} meta={meta} actions={actions} />
      {children}
      {footer && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-0/50 px-3 py-2">
          {footer}
        </footer>
      )}
    </section>
  );
}

/** Label/value line inside a card (key–value readouts). */
export function PropRow({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div
      className={cn(
        "grid min-h-8 grid-cols-[132px_minmax(0,1fr)] items-center gap-3 border-b border-line px-3 py-1.5",
        "last:border-b-0"
      )}
    >
      <span className="text-xs text-fg-3">{label}</span>
      <span className={cn("min-w-0 text-sm break-all text-fg", mono && "font-mono text-xs")}>{children}</span>
    </div>
  );
}

const noticeStyles = {
  fail: { box: "border-fail/40 bg-fail/10 text-fail", icon: <CircleAlertIcon /> },
  invalid: { box: "border-invalid/40 bg-invalid/10 text-invalid", icon: <CircleAlertIcon /> },
  pass: { box: "border-pass/40 bg-pass/10 text-pass", icon: <CircleCheckIcon /> },
  neutral: { box: "border-line-strong bg-surface-2 text-fg-2", icon: <InfoIcon /> }
} as const;

export function Notice({ tone, children, className }: {
  tone: keyof typeof noticeStyles;
  children: ReactNode;
  className?: string;
}) {
  const style = noticeStyles[tone];
  return (
    <div
      role={tone === "fail" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-5",
        "[&>svg]:mt-0.5 [&>svg]:size-3.5 [&>svg]:shrink-0",
        style.box,
        className
      )}
    >
      {style.icon}
      <div className="min-w-0 break-words whitespace-pre-wrap">{children}</div>
    </div>
  );
}

/** Collapsible card (native details/summary) for secondary settings. */
export function Disclosure({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-md border border-line bg-surface-1">
      <summary
        className={cn(
          "flex h-9 cursor-pointer list-none items-center gap-2 px-3 select-none outline-none",
          "transition-colors duration-120 hover:bg-surface-2 [&::-webkit-details-marker]:hidden",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
        )}
      >
        <ChevronRightIcon aria-hidden className="size-3.5 text-fg-3 transition-transform group-open:rotate-90" />
        <span className="tf-label text-fg-2">{title}</span>
        {meta}
      </summary>
      <div className="border-t border-line">{children}</div>
    </details>
  );
}

/** Confirmation dialog that stays open (and locked) while its action is pending. */
export function ActionDialog({ open, title, busy, confirmLabel, busyLabel, danger, onConfirm, onClose, children }: {
  open: boolean;
  title: string;
  busy: boolean;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = () => { if (!busy) onClose(); };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent title={title} size="sm">
        <DialogBody className="grid gap-3 text-fg-2">{children}</DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={close}>取消</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
