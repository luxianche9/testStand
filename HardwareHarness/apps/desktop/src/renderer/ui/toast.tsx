import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CopyIcon, XIcon } from "lucide-react";
import { cn, type Tone } from "./cn";
import { StatusLamp } from "./status";

export type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; message: string; duration: number };

type ToastContextValue = {
  toast: (kind: ToastKind, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);
const tones: Record<ToastKind, Tone> = { success: "pass", error: "fail", info: "run" };
const iconButton = "grid size-5 flex-none place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg";

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
        <div
          className={
            "pointer-events-none fixed right-4 bottom-10 z-[130] flex w-[min(440px,calc(100vw-32px))] " +
            "flex-col items-end gap-2"
          }
        >
          {items.map((item) => (
            <div
              key={item.id}
              role="alert"
              data-kind={item.kind}
              className={cn(
                "pointer-events-auto relative flex max-w-full animate-toast-in items-start gap-2.5 overflow-hidden",
                "rounded-md border border-line-strong bg-surface-3 py-2 pr-2 pl-3 text-sm text-fg shadow-overlay",
                item.kind === "error" && "border-fail/45"
              )}
            >
              <StatusLamp tone={tones[item.kind]} className="mt-1.5" />
              <span className="min-w-0 flex-1 break-words leading-5">{item.message}</span>
              {item.kind === "error" && (
                <button
                  type="button"
                  aria-label="复制错误"
                  className={iconButton}
                  onClick={() => void navigator.clipboard.writeText(item.message)}
                >
                  <CopyIcon className="size-3" />
                </button>
              )}
              <button type="button" aria-label="关闭" className={iconButton} onClick={() => dismiss(item.id)}>
                <XIcon className="size-3.5" />
              </button>
              <span
                className="absolute bottom-0 left-0 h-px bg-current opacity-30"
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
