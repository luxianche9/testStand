import type { ReactNode } from "react";

export function EditorField({ label, required, span, error, children }: {
  label: string;
  required?: boolean;
  span?: boolean;
  error?: string | undefined;
  children: ReactNode;
}) {
  return <label className={`field${span ? " span-2" : ""}`}>
    <span className="field-label">{label}{required && <i>*</i>}</span>
    {children}
    {error && <small className="field-error" role="alert">{error}</small>}
  </label>;
}
