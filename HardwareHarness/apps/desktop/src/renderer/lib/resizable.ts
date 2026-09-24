import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";

export type ResizableWidthOptions = {
  storageKey: string;
  defaultWidth: number;
  min: number;
  /** Upper bound; a function is re-evaluated on window resize (viewport-relative panels). */
  max: number | (() => number);
  /** Direction the pointer moves to grow the panel ("left" for right-hand sidebars). */
  direction: "left" | "right";
  step?: number;
};

function readMax(max: ResizableWidthOptions["max"], min: number) {
  return Math.max(min, typeof max === "function" ? max() : max);
}

function persist(key: string, width: number) {
  try { localStorage.setItem(key, String(width)); } catch { /* Storage may be unavailable; keep resizing usable. */ }
}

/**
 * Persisted, pointer- and keyboard-resizable panel width.
 * Spread `separatorProps` on the handle; it carries the separator role, aria values and handlers.
 */
export function useResizableWidth(options: ResizableWidthOptions) {
  const { storageKey, defaultWidth, min, direction, step = 16 } = options;
  const maxRef = useRef(options.max);
  maxRef.current = options.max;
  const dynamicMax = typeof options.max === "function";
  const staticMax = typeof options.max === "function" ? undefined : options.max;
  const [max, setMax] = useState(() => readMax(options.max, min));
  const clamp = useCallback(
    (value: number) => Math.min(readMax(maxRef.current, min), Math.max(min, Math.round(value))),
    [min]
  );
  const [width, setWidthState] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw?.trim() ? Number(raw) : NaN;
      if (Number.isFinite(saved)) return clamp(saved);
    } catch { /* Storage may be unavailable; keep the panel usable. */ }
    return clamp(defaultWidth);
  });
  const widthRef = useRef(width);
  widthRef.current = width;
  const cleanup = useRef<(() => void) | undefined>(undefined);

  const commit = useCallback((value: number) => {
    const bounded = clamp(value);
    widthRef.current = bounded;
    setWidthState(bounded);
    persist(storageKey, bounded);
    return bounded;
  }, [clamp, storageKey]);

  useEffect(() => () => cleanup.current?.(), []);

  useEffect(() => {
    const sync = () => {
      setMax(readMax(maxRef.current, min));
      const bounded = clamp(widthRef.current);
      if (bounded !== widthRef.current) commit(bounded);
    };
    sync();
    if (!dynamicMax) return;
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [clamp, commit, dynamicMax, min, staticMax]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    cleanup.current?.();
    event.preventDefault();
    const start = { x: event.clientX, width: widthRef.current };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";
    document.body.classList.add("resizing-col");

    const onMove = (move: PointerEvent) => {
      const delta = move.clientX - start.x;
      commit(direction === "left" ? start.width - delta : start.width + delta);
    };
    const onUp = () => {
      handle.dataset.dragging = "false";
      document.body.classList.remove("resizing-col");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      cleanup.current = undefined;
    };
    cleanup.current = onUp;
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    handle.addEventListener("lostpointercapture", onUp);
  }, [commit, direction]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const grow = direction === "left" ? "ArrowLeft" : "ArrowRight";
    const shrink = direction === "left" ? "ArrowRight" : "ArrowLeft";
    const current = widthRef.current;
    const next = event.key === grow ? current + step
      : event.key === shrink ? current - step
        : event.key === "Home" ? min
          : event.key === "End" ? readMax(maxRef.current, min)
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  }, [commit, direction, min, step]);

  const reset = useCallback(() => commit(defaultWidth), [commit, defaultWidth]);

  const separatorProps = {
    role: "separator" as const,
    tabIndex: 0,
    "aria-orientation": "vertical" as const,
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": width,
    onPointerDown,
    onKeyDown,
    onDoubleClick: reset
  };

  return { width, max, reset, setWidth: commit, separatorProps, handleProps: { onPointerDown } };
}
