import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "./cn";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<"input">>(function Input(
  { className, ...props }, ref
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<"textarea">>(function Textarea(
  { className, ...props }, ref
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});

export function Label({ className, ...props }: React.ComponentPropsWithoutRef<"label">) {
  return <label className={cn("text-sm font-medium", className)} {...props} />;
}

/** 原生 select 的统一样式封装,保持表单控件视觉一致。 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentPropsWithoutRef<"select">>(function Select(
  { className, children, ...props }, ref
) {
  return (
    <span className={cn("relative inline-flex w-full items-center", className)}>
      <select
        ref={ref}
        className="h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground" aria-hidden="true" />
    </span>
  );
});

/** 表单字段容器:标签 + 控件 + 说明/错误。自动将 label 关联到第一个表单控件。 */
export function Field({ label, required, error, hint, children, className }: {
  label?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const id = React.useId();
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
    : children;
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
      )}
      {control}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
