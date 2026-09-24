import type { ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";
import { cn, Field } from "../../../../ui";

/** Editor dialog field on the two-column grid; `span` stretches it across both columns. */
export function EditorField({ label, required, span, error, hint, children }: {
  label: string;
  required?: boolean;
  span?: boolean;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Field
      label={label}
      required={required ?? false}
      error={error}
      hint={hint}
      className={cn("content-start", span && "col-span-2")}
    >
      {children}
    </Field>
  );
}

/** Two-column form grid used by every device editor dialog. */
export const editorGrid = "grid grid-cols-2 gap-x-3 gap-y-3";

export function EditorNote({ children }: { children: ReactNode }) {
  return <p className="col-span-2 text-xs leading-5 text-fg-3">{children}</p>;
}

/** Framed block for the photo + port editors inside an editor dialog. */
export function EditorPanel({ children }: { children: ReactNode }) {
  return (
    <div className="col-span-2 grid gap-3 rounded-md border border-line bg-surface-0/60 p-3">{children}</div>
  );
}

export function EditorAlert({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "col-span-2 flex items-start gap-2 rounded-md border border-fail/35 bg-fail/10 px-3 py-2",
        "text-xs break-words whitespace-pre-wrap text-fail"
      )}
    >
      <CircleAlertIcon className="mt-0.5 size-3.5 flex-none" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}
