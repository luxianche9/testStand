import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import { cn } from "./cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const sizeClasses = {
  sm: "w-[420px]",
  default: "w-[560px]",
  lg: "w-[720px]",
  xl: "w-[920px]"
} as const;

export function DialogContent({ size = "default", className, children, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  size?: keyof typeof sizeClasses;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-[100] grid animate-fade-in place-items-center bg-black/50 p-6">
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(
            "flex max-h-[calc(100vh-96px)] max-w-[calc(100vw-96px)] animate-dialog-in flex-col rounded-lg border border-solid border-border bg-background text-foreground shadow-lg outline-none",
            sizeClasses[size],
            className
          )}
          {...props}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ title, onClose, className, children }: {
  title?: string;
  onClose?: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header data-slot="dialog-header" className={cn("flex items-center justify-between gap-3 px-5 pt-5 pb-2", className)}>
      <div className="min-w-0">
        {title && <DialogPrimitive.Title data-slot="dialog-title" className="text-[15px] font-semibold tracking-tight">{title}</DialogPrimitive.Title>}
        {children}
      </div>
      {onClose && (
        <DialogPrimitive.Close asChild>
          <button
            aria-label="关闭"
            className="grid size-7 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <XIcon className="size-4" />
          </button>
        </DialogPrimitive.Close>
      )}
    </header>
  );
}

export function DialogBody({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div data-slot="dialog-body" className={cn("overflow-y-auto px-5 pt-1 pb-5 text-[13px] leading-relaxed", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentPropsWithoutRef<"footer">) {
  return <footer data-slot="dialog-footer" className={cn("flex justify-end gap-2 rounded-b-lg bg-muted/40 px-5 py-3.5", className)} {...props} />;
}
