import type { ReactNode } from "react";
import { cn, toneText, type Tone } from "../../../ui";

const frame: Record<Tone, string> = {
  neutral: "border-line bg-surface-0/40",
  signal: "border-signal/45 bg-signal/6",
  run: "border-run/40 bg-run/6",
  pass: "border-pass/35 bg-pass/5",
  fail: "border-fail/40 bg-fail/6",
  invalid: "border-invalid/40 bg-invalid/6"
};

/** Framed card for OpenCode permission / question interactions; pending ones use the signal accent. */
export function InteractionCard({ tone, icon, title, description, meta, children, footer }: {
  tone: Tone;
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={cn("relative overflow-hidden rounded-md border text-sm", frame[tone])}>
      {tone === "signal" && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      <header className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
        <span aria-hidden className={cn("mt-0.5 shrink-0 [&_svg]:size-4", toneText[tone])}>{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm leading-5 font-medium text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-xs leading-5 text-fg-2">{description}</p>}
        </div>
        {meta}
      </header>
      {children && <div className="grid gap-3 px-3 pb-3">{children}</div>}
      {footer && (
        <footer className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">{footer}</footer>
      )}
    </section>
  );
}
