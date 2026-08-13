import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** 侧栏拖拽调宽：direction 为拖动时宽度增长的方向（"left" 为向左拖变宽，用于右侧栏）。 */
export function useResizableWidth(options: { defaultWidth: number; min: number; max: number; direction: "left" | "right" }) {
  const [width, setWidth] = useState(options.defaultWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
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
      setWidth(Math.min(options.max, Math.max(options.min, Math.round(next))));
    };
    const onUp = () => {
      dragState.current = null;
      document.body.classList.remove("resizing-col");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [options.direction, options.max, options.min, width]);

  return { width, handleProps: { onPointerDown } };
}
