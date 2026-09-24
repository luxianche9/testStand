import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "./cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const widths = { sm: "w-[400px]", md: "w-[520px]", lg: "w-[720px]", xl: "w-[920px]" } as const;

export type DialogContentProps = Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: keyof typeof widths;
  /** Header accessory rendered before the close button. */
  actions?: React.ReactNode;
  closable?: boolean;
};

const firstField = "input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)";

/** Modal with a nameplate header; `title` provides the accessible name. */
export function DialogContent(
  {
    title, description, size = "md", actions, closable = true, className, children, onOpenAutoFocus, ...props
  }: DialogContentProps
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-[100] grid animate-fade-in place-items-center bg-black/55 p-6"
      >
        <DialogPrimitive.Content
          className={cn(
            "flex max-h-[calc(100vh-80px)] max-w-[calc(100vw-80px)] animate-dialog-in flex-col overflow-hidden",
            "rounded-lg border border-line-strong bg-surface-1 text-fg shadow-overlay outline-none",
            widths[size],
            className
          )}
          {...props}
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event);
            if (event.defaultPrevented) return;
            // Prefer the first form field over the header's close button.
            const field = (event.target as HTMLElement).querySelector<HTMLElement>(firstField);
            if (!field) return;
            event.preventDefault();
            field.focus();
          }}
        >
          <header className="flex min-h-10 items-center gap-2 border-b border-line px-4">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title}
            </DialogPrimitive.Title>
            {actions}
            {closable && (
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="关闭"><XIcon /></Button>
              </DialogPrimitive.Close>
            )}
          </header>
          {description ? (
            <DialogPrimitive.Description className="px-4 pt-3 text-sm text-fg-2">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Portal>
  );
}

export function DialogBody({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("min-h-0 overflow-y-auto px-4 py-3 text-sm", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentPropsWithoutRef<"footer">) {
  return (
    <footer
      className={cn("flex items-center justify-end gap-2 border-t border-line bg-surface-0/60 px-4 py-2.5", className)}
      {...props}
    />
  );
}

/** Replaces window.confirm: resolves the decision through callbacks instead of blocking. */
export function ConfirmDialog({ open, title, message, confirmLabel = "确认", danger, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent title={title} size="sm">
        <DialogBody className="text-fg-2">{message}</DialogBody>
        <DialogFooter>
          <Button onClick={onCancel}>取消</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Hook form of ConfirmDialog: `const [confirm, dialog] = useConfirm(); if (await confirm({...}))`. */
export function useConfirm(): [
  (options: { title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean }) => Promise<boolean>,
  React.ReactNode
] {
  const [state, setState] = React.useState<{
    title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void;
  } | null>(null);
  const confirm = React.useCallback((options: {
    title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean;
  }) => new Promise<boolean>((resolve) => setState({ ...options, resolve })), []);
  const settle = (ok: boolean) => { state?.resolve(ok); setState(null); };
  const dialog = state ? (
    <ConfirmDialog
      open
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel ?? "确认"}
      danger={state.danger ?? false}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;
  return [confirm, dialog];
}
