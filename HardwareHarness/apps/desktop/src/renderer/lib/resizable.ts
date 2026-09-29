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
  /**
   * Direction the pointer moves to grow the panel ("left" for right-hand sidebars, "up" for bottom panels).
   * "up" / "down" make the size a height.
   */
  direction: "left" | "right" | "up" | "down";
  step?: number;
};

function readMax(max: ResizableWidthOptions["max"], min: number) {
  return Math.max(min, typeof max === "function" ? max() : max);
}

function persist(key: string, width: number) {
  try { localStorage.setItem(key, String(width)); } catch { /* Storage may be unavailable; keep resizing usable. */ }
}

/**
 * Persisted, pointer- and keyboard-resizable panel width (or height, for "up" / "down").
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
  const vertical = direction === "up" || direction === "down";
  const negative = direction === "left" || direction === "up";

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
    const start = { at: vertical ? event.clientY : event.clientX, width: widthRef.current };
    const bodyClass = vertical ? "resizing-row" : "resizing-col";
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";
    document.body.classList.add(bodyClass);

    const onMove = (move: PointerEvent) => {
      const delta = (vertical ? move.clientY : move.clientX) - start.at;
      commit(negative ? start.width - delta : start.width + delta);
    };
    const onUp = () => {
      handle.dataset.dragging = "false";
      document.body.classList.remove(bodyClass);
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
  }, [commit, negative, vertical]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const [back, forward] = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    const grow = negative ? back : forward;
    const shrink = negative ? forward : back;
    const current = widthRef.current;
    const next = event.key === grow ? current + step
      : event.key === shrink ? current - step
        : event.key === "Home" ? min
          : event.key === "End" ? readMax(maxRef.current, min)
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  }, [commit, min, negative, step, vertical]);

  const reset = useCallback(() => commit(defaultWidth), [commit, defaultWidth]);

  const separatorProps = {
    role: "separator" as const,
    tabIndex: 0,
    "aria-orientation": vertical ? "horizontal" as const : "vertical" as const,
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": width,
    onPointerDown,
    onKeyDown,
    onDoubleClick: reset
  };

  return { width, max, reset, setWidth: commit, separatorProps, handleProps: { onPointerDown } };
}
