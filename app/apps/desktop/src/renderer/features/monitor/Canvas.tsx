import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GripIcon, XIcon } from "lucide-react";
import {
  GRID_PX, PANEL_SIZES, type ControlWidget, type Frame, type MonitorPanel, type PanelType
} from "@teststand/contracts/monitor";
import { cn, IconButton } from "../../ui/index.js";
import { useLatestValues } from "../variables/use-latest-values.js";
import { BARE_TYPES, canvasExtent, cells, moved, resized, widgetForStream } from "./canvas-model.js";
import { CONTROL_MIME, newControlPanelId, requestControl } from "./control-requests.js";
import { PANEL_COMPONENTS } from "./MonitorPanels.js";
import { PANEL_ICONS } from "./panel-icons.js";
import { useStreamDrag } from "./panel-kit.js";
import { LatestValuesContext, latestKeys } from "./panels/Widgets.js";
import {
  draggedStreamType, PANEL_LABELS, PANEL_MIME, panelTitle, readDraggedStream, type MonitorWorkspace
} from "./use-monitor-workspace.js";

/** A control dropped from the component bar becomes this widget (presets live in a control panel). */
const CONTROL_WIDGETS: Record<ControlWidget, PanelType> = {
  button: "button", toggle: "switch", slider: "slider", presets: "control"
};

const GRID_BACKGROUND = {
  backgroundImage: "linear-gradient(to right, var(--color-line) 1px, transparent 1px), "
    + "linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
  backgroundSize: `${GRID_PX}px ${GRID_PX}px`
};

/**
 * 运行监控's canvas: one page on which every panel sits where it was put, like a host-computer front panel.
 * In 编辑 mode panels are dragged, resized on their corner, selected for the property panel and removed;
 * components and variables dropped on an empty spot make a panel there. Otherwise the panels are live.
 */
export function Canvas({ workspace, editing, selected, onSelect, empty }: {
  workspace: MonitorWorkspace;
  editing: boolean;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** Offered while the canvas is empty. */
  empty: ReactNode;
}) {
  const panels = workspace.monitor.panels as Array<MonitorPanel & { frame: Frame }>;
  const values = useLatestValues(latestKeys(panels), true);
  const extent = useMemo(() => canvasExtent(panels.map((panel) => panel.frame)), [panels]);
  const surface = useRef<HTMLDivElement>(null);
  const dragging = useStreamDrag();

  useEffect(() => {
    if (!editing || !selected) return undefined;
    const remove = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      workspace.removePanel(selected);
      onSelect(undefined);
    };
    window.addEventListener("keydown", remove);
    return () => window.removeEventListener("keydown", remove);
  }, [editing, selected, workspace, onSelect]);

  /** Where on the canvas (cells) an event happened. */
  const at = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = surface.current?.getBoundingClientRect();
    return { x: cells(clientX - (box?.left ?? 0) - GRID_PX / 2), y: cells(clientY - (box?.top ?? 0) - GRID_PX / 2) };
  };
  const frameAt = (type: PanelType, point: { x: number; y: number }): Frame =>
    ({ ...point, w: PANEL_SIZES[type][0], h: PANEL_SIZES[type][1] });

  return (
    <LatestValuesContext.Provider value={values}>
      <div role="region" aria-label="画布" className="relative min-h-0 flex-1 overflow-auto bg-surface-0"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget || event.target === surface.current) onSelect(undefined);
        }}>
        <div ref={surface} data-testid="canvas-surface" className="relative"
          style={{
            width: extent.width, height: extent.height, minWidth: "100%", minHeight: "100%",
            ...(editing ? GRID_BACKGROUND : {})
          }}
          onDragOver={(event) => {
            const types = [...event.dataTransfer.types];
            const known = types.includes(PANEL_MIME) || types.includes(CONTROL_MIME)
              || draggedStreamType(types) !== undefined;
            if (!known) return;
            if ((event.target as HTMLElement).closest("[data-canvas-item]")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => {
            const onto = (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-item]");
            const point = at(event.clientX, event.clientY);
            const widget = event.dataTransfer.getData(CONTROL_MIME) as ControlWidget | "";
            if (widget) {
              event.preventDefault();
              const target = onto ? panels.find((panel) => panel.id === onto.dataset.canvasItem) : undefined;
              if (target?.type === "control") { requestControl(target.id, widget); return; }
              const type = CONTROL_WIDGETS[widget];
              if (type === "control") {
                const id = newControlPanelId();
                workspace.addPanel("control", [], frameAt("control", point), id);
                requestControl(id, widget);
              } else {
                workspace.addPanel(type, [], frameAt(type, point));
              }
              return;
            }
            if (onto) return; // a panel that takes the stream handled it; others do not make a new one
            const type = event.dataTransfer.getData(PANEL_MIME) as PanelType | "";
            if (type && PANEL_LABELS[type]) {
              event.preventDefault();
              workspace.addPanel(type, [], frameAt(type, point));
              return;
            }
            const ref = readDraggedStream(event.dataTransfer);
            if (!ref) return;
            event.preventDefault();
            // The device's declaration when it is known, else the type the drag carries.
            const streamType = workspace.typeOf(ref) ?? (draggedStreamType([...event.dataTransfer.types]) || undefined);
            const kind = widgetForStream(streamType, workspace.declarationOf(ref));
            workspace.addPanel(kind, [ref], frameAt(kind, point));
          }}>
          {panels.map((panel) => (
            <CanvasItem key={panel.id} panel={panel} editing={editing} streamDrag={dragging !== undefined}
              selected={selected === panel.id} onSelect={() => onSelect(panel.id)}
              onMove={(frame) => workspace.move(panel.id, frame)}
              onRemove={() => { workspace.removePanel(panel.id); if (selected === panel.id) onSelect(undefined); }} />
          ))}
        </div>
        {!panels.length && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
            <div className="pointer-events-auto grid max-w-md justify-items-center gap-2 text-xs text-fg-3">
              <p className="text-sm text-fg-2">这是一整页画布，像上位机界面一样自由摆放</p>
              <p>从活动栏「组件」把显示组件、开关、按钮拖到这里；或从「变量」把变量直接拖到空白处，自动生成合适的控件。</p>
              {empty}
            </div>
          </div>
        )}
      </div>
    </LatestValuesContext.Provider>
  );
}

type Gesture = { kind: "move" | "resize"; x: number; y: number; frame: Frame; travelled: boolean };

function CanvasItem({ panel, editing, selected, streamDrag, onSelect, onMove, onRemove }: {
  panel: MonitorPanel & { frame: Frame };
  editing: boolean;
  selected: boolean;
  /** A stream is being dragged: the panel itself must get the drop, not the edit overlay. */
  streamDrag: boolean;
  onSelect: () => void;
  onMove: (frame: Frame) => void;
  onRemove: () => void;
}) {
  const [gesture, setGesture] = useState<Gesture>();
  const [preview, setPreview] = useState<Frame>();
  const frame = preview ?? panel.frame;
  const Component = PANEL_COMPONENTS[panel.type];
  const TypeIcon = PANEL_ICONS[panel.type];
  const bare = BARE_TYPES.has(panel.type);

  const start = (kind: Gesture["kind"]) => (event: ReactPointerEvent) => {
    if (!editing || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setGesture({ kind, x: event.clientX, y: event.clientY, frame: panel.frame, travelled: false });
    onSelect();
  };
  const follow = (event: ReactPointerEvent) => {
    if (!gesture) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.travelled && Math.hypot(dx, dy) < 3) return;
    if (!gesture.travelled) setGesture({ ...gesture, travelled: true });
    setPreview(gesture.kind === "move" ? moved(gesture.frame, dx, dy) : resized(gesture.frame, dx, dy));
  };
  const finish = () => {
    if (preview && (preview.x !== panel.frame.x || preview.y !== panel.frame.y
      || preview.w !== panel.frame.w || preview.h !== panel.frame.h)) onMove(preview);
    setGesture(undefined);
    setPreview(undefined);
  };

  return (
    // The frame is the panel's grid box; the card sits a few pixels inside it, so neighbours keep a gap.
    <div data-canvas-item={panel.id} role="group" aria-label={panelTitle(panel)} className="absolute p-[3px]"
      style={{ left: frame.x * GRID_PX, top: frame.y * GRID_PX, width: frame.w * GRID_PX, height: frame.h * GRID_PX }}>
      <div className={cn("relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-surface-1",
          "shadow-[0_1px_2px_rgb(0_0_0/0.06)]", editing ? "border-line-strong" : "border-line",
          selected && editing && "ring-2 ring-signal", preview && "opacity-80 shadow-overlay")}>
        {!bare && (
          <header className={cn("flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-surface-1 px-2 text-xs",
            editing && "cursor-move")}
            onPointerDown={start("move")} onPointerMove={follow} onPointerUp={finish}>
            {editing ? <GripIcon className="size-3.5 text-fg-3" /> : <TypeIcon className="size-3.5 text-fg-3" />}
            <span className="truncate font-medium text-fg">{panelTitle(panel)}</span>
          </header>
        )}
        <div className="relative min-h-0 flex-1">
          <Component api={{ id: panel.id }} />
          {editing && !streamDrag && (
            // While editing, the panel is moved and picked, not operated.
            <div aria-label={`移动 ${panelTitle(panel)}`} className="absolute inset-0 z-30 cursor-move"
              onPointerDown={start("move")} onPointerMove={follow} onPointerUp={finish} />
          )}
        </div>
        {editing && (
          <>
            <IconButton label={`删除 ${panelTitle(panel)}`} size="icon-xs" variant="ghost"
              className="absolute top-0.5 right-0.5 z-40 bg-surface-1/80" onClick={onRemove}>
              <XIcon />
            </IconButton>
            <div aria-label={`调整 ${panelTitle(panel)} 的大小`} role="separator"
              className="absolute right-0 bottom-0 z-40 size-3 cursor-nwse-resize border-r-2 border-b-2 border-signal"
              onPointerDown={start("resize")} onPointerMove={follow} onPointerUp={finish} />
          </>
        )}
      </div>
    </div>
  );
}
