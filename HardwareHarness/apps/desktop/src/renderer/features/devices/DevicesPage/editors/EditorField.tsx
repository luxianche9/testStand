import type { ReactNode } from "react";
import { cn } from "../../../../shared/ui/cn";

export function EditorField({ label, required, span, error, children }: {
  label: string;
  required?: boolean;
  span?: boolean;
  error?: string | undefined;
  children: ReactNode;
}) {
  return <label className={cn("grid content-start gap-1.5", span && "col-span-2")}>
    <span className="text-xs text-muted-foreground">{label}{required && <i className="ml-0.5 text-destructive not-italic">*</i>}</span>
    {children}
    {error && <small className="text-[11px] text-destructive" role="alert">{error}</small>}
  </label>;
}
