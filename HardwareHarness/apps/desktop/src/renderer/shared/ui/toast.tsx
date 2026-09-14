import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleCheckIcon, CircleAlertIcon, CopyIcon, InfoIcon, XIcon } from "lucide-react";
import { cn } from "./cn";

export type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; message: string; duration: number };

type ToastContextValue = {
  toast: (kind: ToastKind, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const icons: Record<ToastKind, ReactNode> = {
  success: <CircleCheckIcon className="size-4 text-success" />,
  error: <CircleAlertIcon className="size-4 text-destructive" />,
  info: <InfoIcon className="size-4 text-ring" />
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    const duration = kind === "error" ? 6000 : 4000;
    setItems((current) => [...current.slice(-3), { id, kind, message, duration }]);
    window.setTimeout(() => dismiss(id), duration);
  }, [dismiss]);

  const value = useMemo<ToastContextValue>(() => ({
    toast,
    success: (message) => toast("success", message),
    error: (message) => toast("error", message),
    info: (message) => toast("info", message)
  }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[130] flex w-full max-w-[min(680px,calc(100vw-40px))] -translate-x-1/2 flex-col items-center gap-2">
          {items.map((item) => (
            <div
              key={item.id}
              role="alert"
              className={cn(
                "pointer-events-auto relative flex w-auto max-w-full animate-toast-in items-center gap-2.5 overflow-hidden rounded-lg border border-solid border-border bg-popover px-3.5 py-2.5 text-sm text-popover-foreground shadow-lg",
                item.kind === "error" && "border-destructive/30"
              )}
            >
              {icons[item.kind]}
              <span className="min-w-0 break-words">{item.message}</span>
              {item.kind === "error" && (
                <button
                  aria-label="复制错误"
                  className="ml-0.5 grid size-5 flex-none place-items-center rounded text-muted-foreground hover:text-foreground"
                  onClick={() => void navigator.clipboard.writeText(item.message)}
                >
                  <CopyIcon className="size-3" />
                </button>
              )}
              <button
                aria-label="关闭"
                className="ml-0.5 grid size-5 flex-none place-items-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => dismiss(item.id)}
              >
                <XIcon className="size-3.5" />
              </button>
              <span
                className="absolute bottom-0 left-0 h-[2px] bg-current opacity-15"
                style={{ animation: `tf-toast-progress ${item.duration}ms linear forwards` }}
              />
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return context;
}
