import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { RotateCcwIcon, RotateCwIcon, ScanIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { IconButton } from "./button";
import { Dialog, DialogContent } from "./dialog";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const INITIAL = { scale: 1, rotation: 0, x: 0, y: 0 };

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Full-size photo viewer: wheel or buttons to zoom, 90° rotation, drag to pan, 0 to reset. */
export function ImageViewer({ src, title, open, onOpenChange }: {
  src: string | undefined;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState(INITIAL);
  const drag = useRef<{ x: number; y: number; originX: number; originY: number }>(undefined);
  const zoom = (factor: number) => setView((current) => ({ ...current, scale: clampScale(current.scale * factor) }));
  const rotate = (degrees: number) => setView((current) => ({ ...current, rotation: current.rotation + degrees }));
  const reset = () => setView(INITIAL);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setView((current) => ({
      ...current,
      x: start.originX + event.clientX - start.x,
      y: start.originY + event.clientY - start.y
    }));
  };
  const endDrag = () => { drag.current = undefined; };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent
        title={title}
        size="xl"
        className="h-[calc(100vh-96px)] w-[calc(100vw-96px)]"
        actions={(
          <span className="flex items-center gap-0.5">
            <IconButton label="缩小" size="icon-sm" onClick={() => zoom(1 / 1.25)}><ZoomOutIcon /></IconButton>
            <span className="tf-num w-11 text-center text-2xs text-fg-3">{Math.round(view.scale * 100)}%</span>
            <IconButton label="放大" size="icon-sm" onClick={() => zoom(1.25)}><ZoomInIcon /></IconButton>
            <IconButton label="向左旋转" size="icon-sm" onClick={() => rotate(-90)}><RotateCcwIcon /></IconButton>
            <IconButton label="向右旋转" size="icon-sm" onClick={() => rotate(90)}><RotateCwIcon /></IconButton>
            <IconButton label="复位" size="icon-sm" onClick={reset}><ScanIcon /></IconButton>
          </span>
        )}
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") zoom(1.25);
          else if (event.key === "-") zoom(1 / 1.25);
          else if (event.key === "r" || event.key === "R") rotate(event.shiftKey ? -90 : 90);
          else if (event.key === "0") reset();
        }}
      >
        <div
          className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-surface-0 active:cursor-grabbing"
          onWheel={(event) => zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
        >
          {src && (
            <img
              src={src}
              alt={title}
              draggable={false}
              className="absolute inset-0 size-full object-contain select-none"
              style={{
                transform: `translate(${view.x}px, ${view.y}px) rotate(${view.rotation}deg) scale(${view.scale})`
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
