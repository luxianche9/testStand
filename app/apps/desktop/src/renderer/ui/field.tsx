import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "./cn";

const control = [
  "w-full min-w-0 rounded-md border border-line-strong bg-surface-0 text-sm text-fg outline-none",
  "transition-[border-color,background-color] duration-120 hover:border-fg-3/60",
  "focus-visible:border-signal focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-fail"
].join(" ");

export const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<"input">>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(control, "h-7 px-2", className)} {...props} />;
  }
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(control, "min-h-16 resize-y px-2 py-1.5", className)} {...props} />;
  }
);

/** Native select: keeps empty options, optgroups and keyboard behaviour intact. */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentPropsWithoutRef<"select">>(
  function Select({ className, children, ...props }, ref) {
    return (
      <span className={cn("relative inline-flex w-full items-center", className)}>
        <select
          ref={ref}
          className={cn(
            control,
            "h-7 appearance-none pr-7 pl-2",
            "[&_optgroup]:bg-surface-2 [&_optgroup]:text-fg [&_option]:bg-surface-2 [&_option]:text-fg"
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDownIcon aria-hidden className="pointer-events-none absolute right-2 size-3.5 text-fg-3" />
      </span>
    );
  }
);

export function Label({ className, ...props }: React.ComponentPropsWithoutRef<"label">) {
  return <label className={cn("text-xs font-medium text-fg-2", className)} {...props} />;
}

/** Label + control + hint/error. The label is linked to the single child control. */
export function Field({ label, required, error, hint, children, className, inline }: {
  label?: React.ReactNode;
  required?: boolean;
  error?: string | undefined;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Put the label to the left of the control (inspector rows). */
  inline?: boolean;
}) {
  const id = React.useId();
  const child = React.isValidElement<{ id?: string }>(children) ? children : null;
  const controlId = child?.props.id ?? id;
  const control = child ? React.cloneElement(child, { id: controlId }) : children;
  return (
    <div className={cn(inline ? "grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2" : "grid gap-1", className)}>
      {label && (
        <Label htmlFor={controlId}>
          {label}
          {required && <span className="ml-0.5 text-fail">*</span>}
        </Label>
      )}
      {control}
      {error ? (
        <p className={cn("text-xs text-fail", inline && "col-start-2")}>{error}</p>
      ) : hint ? (
        <p className={cn("text-xs text-fg-3", inline && "col-start-2")}>{hint}</p>
      ) : null}
    </div>
  );
}
