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
      <DialogPrimitive.Overlay className="fixed inset-0 z-[100] grid animate-fade-in place-items-center bg-black/45 p-6">
        <DialogPrimitive.Content
          className={cn(
            "flex max-h-[calc(100vh-96px)] max-w-[calc(100vw-96px)] animate-dialog-in flex-col rounded-lg border bg-background shadow-2xl outline-none",
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
    <header className={cn("flex items-center justify-between gap-3 px-4 pt-4 pb-2", className)}>
      <div className="min-w-0">
        {title && <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>}
        {children}
      </div>
      {onClose && (
        <DialogPrimitive.Close asChild>
          <button
            aria-label="关闭"
            className="grid size-7 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </DialogPrimitive.Close>
      )}
    </header>
  );
}

export function DialogBody({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("overflow-y-auto px-4 pt-1 pb-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentPropsWithoutRef<"footer">) {
  return <footer className={cn("flex justify-end gap-2 border-t px-4 py-3", className)} {...props} />;
}
