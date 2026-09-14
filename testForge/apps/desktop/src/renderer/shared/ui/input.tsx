import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "./cn";

// shadcn new-york-v4 styles, retaining the existing native refs and form props.
export const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<"input">>(function Input(
  { className, ...props }, ref
) {
  return (
    <input
      ref={ref}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-solid border-input bg-transparent px-3 py-1 text-[13px] text-foreground shadow-xs outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
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
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full resize-y rounded-md border border-solid border-input bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  );
});

export function Label({ className, ...props }: React.ComponentPropsWithoutRef<"label">) {
  return <label data-slot="label" className={cn("text-[12.5px] font-medium text-foreground", className)} {...props} />;
}

/** shadcn NativeSelect 皮肤；保留原生空值、optgroup、事件、ref 和外层 className。 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentPropsWithoutRef<"select">>(function Select(
  { className, children, ...props }, ref
) {
  return (
    <span data-slot="native-select-wrapper" className={cn("relative inline-flex w-full items-center", className)}>
      <select
        ref={ref}
        data-slot="native-select"
        className="h-9 w-full min-w-0 appearance-none rounded-md border border-solid border-input bg-transparent px-3 pr-8 text-[13px] text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40 [&_option]:bg-[Canvas] [&_option]:text-[CanvasText] [&_optgroup]:bg-[Canvas] [&_optgroup]:text-[CanvasText]"
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon data-slot="native-select-icon" className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground opacity-50" aria-hidden="true" />
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
