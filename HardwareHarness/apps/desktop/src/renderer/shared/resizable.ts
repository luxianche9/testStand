import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** 侧栏拖拽调宽：direction 为拖动时宽度增长的方向（"left" 为向左拖变宽，用于右侧栏）。 */
export function useResizableWidth(options: { storageKey: string; defaultWidth: number; min: number; max: number; direction: "left" | "right" }) {
  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(options.storageKey);
      const saved = raw?.trim() ? Number(raw) : NaN;
      if (Number.isFinite(saved)) return Math.min(options.max, Math.max(options.min, Math.round(saved)));
    } catch { /* Storage may be unavailable; keep the panel usable. */ }
    return options.defaultWidth;
  });
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    cleanup.current?.();
    event.preventDefault();
    dragState.current = { startX: event.clientX, startWidth: width };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-col");

    const onMove = (move: PointerEvent) => {
      const start = dragState.current;
      if (!start) return;
      const delta = move.clientX - start.startX;
      const next = options.direction === "left" ? start.startWidth - delta : start.startWidth + delta;
      const bounded = Math.min(options.max, Math.max(options.min, Math.round(next)));
      setWidth(bounded);
      try { localStorage.setItem(options.storageKey, String(bounded)); } catch { /* Keep resizing usable. */ }
    };
    const onUp = () => {
      dragState.current = null;
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
  }, [options.direction, options.max, options.min, options.storageKey, width]);

  return { width, handleProps: { onPointerDown } };
}
