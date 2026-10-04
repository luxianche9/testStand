import { useEffect, useRef, type CSSProperties, type PointerEvent } from "react";
import { Handle, NodeResizer, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import type { PortPosition, PortSide } from "@teststand/contracts/wiring";
import { SlidersHorizontalIcon } from "lucide-react";
import { cn } from "../../ui/index.js";
import {
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  nearestPortPosition,
  portSignal,
  reactFlowPosition,
  type HardwareFlowNode
} from "./wiring-model.js";

/** A device on the bench, drawn as an instrument faceplate: mono caption and one connector pin per
 *  port sitting on the card edge. */
function HardwareNode({ id, data, selected, width, height }: NodeProps<HardwareFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const interactive = data.interactive !== false;
  useEffect(() => {
    updateNodeInternals(id);
  }, [data.portPositions, height, id, updateNodeInternals, width]);
  const portSummary = data.resolved ? `${data.hardware.ports.length} 个端口` : "设备资料未解析";
  return (
    <div
      data-hardware-id={id}
      data-connector-editing={data.portEditing ? "true" : "false"}
      className={cn(
        "flow-hardware-node",
        selected && "selected",
        data.portEditing && "connector-editing",
        !data.resolved && "unresolved"
      )}
      title={`${data.hardware.label}\n${portSummary}`}
      aria-label={data.hardware.label}
    >
      <NodeResizer
        isVisible={interactive && selected}
        minWidth={MIN_CARD_WIDTH}
        minHeight={MIN_CARD_HEIGHT}
        maxWidth={MAX_CARD_WIDTH}
        maxHeight={MAX_CARD_HEIGHT}
        autoScale
        onResizeEnd={(_event, params) => data.resizeNode(id, params.width, params.height)}
      />
      <div className="flow-node-body">
        <div className="flow-node-caption">{data.hardware.label}</div>
        {data.onControl && interactive && (
          <button
            type="button"
            className="flow-node-control nodrag"
            aria-label={`控制 ${data.hardware.label}`}
            onClick={(event) => {
              event.stopPropagation();
              data.onControl?.(id, event.currentTarget.getBoundingClientRect());
            }}
          >
            <SlidersHorizontalIcon aria-hidden />控制
          </button>
        )}
      </div>
      {data.hardware.ports.map((port) => (
        <DraggablePort
          key={port.portId}
          nodeId={id}
          portId={port.portId}
          label={port.name}
          signal={portSignal(port)}
          position={data.portPositions[port.portId] ?? { side: "right", offset: 0.5 }}
          editing={interactive && data.portEditing}
          interactive={interactive}
          onMove={(side, offset) => data.movePort(data.hardware.hardwareId, port.portId, side, offset)}
        />
      ))}
    </div>
  );
}

type DragState = { card: DOMRect; element: HTMLDivElement; side: PortSide; offset: number };

/** One connector. Dragging its handle draws a cable; in port-editing mode the hit area instead
 *  slides the connector along the card edge (committed on pointer up). */
function DraggablePort({ nodeId, portId, label, signal, position, editing, interactive, onMove }: {
  nodeId: string;
  portId: string;
  label: string;
  signal: string | undefined;
  position: PortPosition;
  editing: boolean;
  interactive: boolean;
  onMove: (side: PortSide, offset: number) => void;
}) {
  const drag = useRef<DragState | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!editing) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget.parentElement as HTMLDivElement | null;
    const card = event.currentTarget.closest(".flow-hardware-node")?.getBoundingClientRect();
    if (!element || !card) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { card, element, side: position.side, offset: position.offset };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    event.preventDefault();
    const next = nearestPortPosition(current.card, event.clientX, event.clientY);
    current.side = next.side;
    current.offset = next.offset;
    current.element.dataset.side = next.side;
    current.element.style.setProperty("--connector-offset", `${next.offset * 100}%`);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    event.stopPropagation();
    drag.current = null;
    onMove(current.side, current.offset);
    queueMicrotask(() => updateNodeInternals(nodeId));
  };
  const caption = <span className="flow-connector-label">{label}</span>;
  return (
    <div
      className="flow-connector nodrag"
      data-side={position.side}
      data-signal={signal}
      style={{ "--connector-offset": `${position.offset * 100}%` } as CSSProperties}
    >
      <Handle
        id={portId}
        type="source"
        position={reactFlowPosition(position.side)}
        className="flow-connector-handle"
        isConnectable={interactive}
        title={`从 ${label} 创建接线`}
      />
      {interactive ? (
        <button
          type="button"
          className="flow-connector-hit"
          title={editing ? `拖动 ${label} 改变端口位置` : label}
          aria-label={editing ? `拖动端口 ${label}` : `端口 ${label}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
        >
          {caption}
        </button>
      ) : <span className="flow-connector-hit" aria-hidden="true">{caption}</span>}
    </div>
  );
}

export const wiringNodeTypes = { hardware: HardwareNode };
