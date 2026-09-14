import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Handle, NodeResizer, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import type { Hardware } from "@testforge/contracts/devices";
import type { PortPosition, PortSide } from "@testforge/contracts/wiring";
import { CableIcon, CpuIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "../../shared/ui/cn";
import { Badge, badgeVariantFromTone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useDashboard } from "../../shared/queries.js";
import {
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT_LABEL,
  MIN_CARD_HEIGHT_WITH_IMAGE,
  MIN_CARD_WIDTH,
  assetKey,
  nearestPortPosition,
  reactFlowPosition,
  type HardwareFlowNode
} from "./wiring-model.js";

export function HardwareLibrary({ hardware, assetUrls, placed, onAdd, onRefresh }: {
  hardware: Hardware[];
  assetUrls: Record<string, string>;
  placed: Set<string>;
  onAdd: (hardwareId: string) => void;
  onRefresh: () => void;
}) {
  const dashboard = useDashboard();
  const [checking, setChecking] = useState(false);
  // Online state comes from the availability probe, keyed by hardwareId; passive (non-MCP)
  // hardware has no probe and is shown as such rather than "offline".
  const availability = useMemo(() => new Map((dashboard.data?.availability ?? []).map((item) => [item.hardwareId, item])), [dashboard.data]);

  const check = async () => {
    setChecking(true);
    try { await window.testforge.devices.refreshManagedHardware(); } catch { /* a half-down MCP still reports per-hardware state below */ }
    await dashboard.refetch();
    onRefresh();
    setChecking(false);
  };

  return <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-secondary/40">
    <header className="flex items-center justify-between gap-2 bg-card px-3 py-2.5">
      <strong className="truncate text-sm font-semibold">硬件库</strong>
      <Button variant="ghost" size="sm" disabled={checking} onClick={() => void check()}>
        <RefreshCwIcon className={cn("size-3.5", checking && "animate-spin")} />刷新
      </Button>
    </header>
    <div className="min-h-0 overflow-auto p-2.5">
      {hardware.map((item) => {
        const onCanvas = placed.has(item.hardwareId);
        const url = item.appearanceAssetId ? assetUrls[assetKey(item.hardwareId, item.appearanceAssetId)] : undefined;
        const state = item.kind === "managed" ? availability.get(item.hardwareId)?.state ?? "checking" : undefined;
        return <article
          className={cn(
            "mb-2 overflow-hidden rounded-xl bg-card shadow-sm ring-1 transition-[box-shadow,ring-color,transform] active:scale-[0.99]",
            onCanvas ? "ring-ring/60" : "ring-border"
          )}
          key={item.hardwareId}
          draggable={!onCanvas}
          onDragStart={(event) => { event.dataTransfer.setData("application/testforge-hardware", item.hardwareId); event.dataTransfer.effectAllowed = "move"; }}
        >
          <button
            className="flex h-10 w-full items-center gap-2 px-2 py-1 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default"
            onClick={() => onAdd(item.hardwareId)}
            disabled={onCanvas}
          >
            <span className="grid size-[30px] flex-none place-items-center overflow-hidden rounded-md bg-secondary text-muted-foreground shadow-sm ring-1 ring-border [&_img]:size-full [&_img]:object-contain">
              {url ? <img src={url} alt="" /> : <CpuIcon className="size-5" />}
            </span>
            <span className="min-w-0 flex-1"><strong className="block truncate text-xs">{item.label}</strong></span>
            <Badge variant={badgeVariantFromTone(onlineTone(item, state))} className="ml-auto flex-none">{onlineText(item, state)}</Badge>
          </button>
        </article>;
      })}
      {!hardware.length && <div className="p-4 text-xs leading-normal text-muted-foreground">还没有登记设备。请到「设备管理」页登记硬件及其端口。</div>}
    </div>
  </aside>;
}

/** 在线状态：受管硬件看可用性探测，非受管（纯接线对象）没有远端可探，显示为「被动」。 */
function onlineText(item: Hardware, state: string | undefined): string {
  if (item.kind !== "managed") return "被动";
  if (state === "available") return "在线";
  if (state === "checking") return "检测中";
  return "离线";
}

function onlineTone(item: Hardware, state: string | undefined): "ok" | "warn" | "bad" | "muted" {
  if (item.kind !== "managed") return "muted";
  if (state === "available") return "ok";
  if (state === "checking") return "warn";
  return "bad";
}

function HardwareNode({ id, data, selected, width, height }: NodeProps<HardwareFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const showImage = data.showImage;
  const interactive = data.interactive !== false;
  useEffect(() => {
    updateNodeInternals(id);
  }, [data.portPositions, data.showImage, height, id, updateNodeInternals, width]);
  return <div
    data-hardware-id={id}
    data-connector-editing={data.portEditing ? "true" : "false"}
    data-show-image={showImage ? "true" : "false"}
    className={`flow-hardware-node${selected ? " selected" : ""}${data.portEditing ? " connector-editing" : ""}${showImage ? "" : " image-hidden"}${data.resolved ? "" : " unresolved"}`}
    title={`${data.hardware.label}\n${data.resolved ? `${data.hardware.ports.length} 个端口` : "设备资料未解析"}`}
    aria-label={data.hardware.label}
  >
    <NodeResizer
      isVisible={interactive && selected}
      minWidth={MIN_CARD_WIDTH}
      minHeight={showImage ? MIN_CARD_HEIGHT_WITH_IMAGE : MIN_CARD_HEIGHT_LABEL}
      maxWidth={MAX_CARD_WIDTH}
      maxHeight={MAX_CARD_HEIGHT}
      autoScale
      onResizeEnd={(_event, params) => data.resizeNode(id, params.width, params.height)}
    />
    <div className="flow-node-body">
      {showImage && (
        <div className="flow-node-image">
          {data.imageUrl ? <img src={data.imageUrl} alt={data.hardware.label} /> : <CableIcon className="size-9" />}
        </div>
      )}
      <div className="flow-node-caption">{data.hardware.label}</div>
    </div>
    {data.hardware.ports.map((port) => {
      const position = data.portPositions[port.portId] ?? { side: "right" as const, offset: 0.5 };
      return <DraggablePort
        key={port.portId}
        nodeId={id}
        portId={port.portId}
        label={port.name}
        position={position}
        editing={interactive && data.portEditing}
        interactive={interactive}
        onMove={(side, offset) => data.movePort(data.hardware.hardwareId, port.portId, side, offset)}
      />;
    })}
  </div>;
}

function DraggablePort({ nodeId, portId, label, position, editing, interactive, onMove }: {
  nodeId: string; portId: string; label: string; position: PortPosition; editing: boolean; interactive: boolean;
  onMove: (side: PortSide, offset: number) => void;
}) {
  const drag = useRef<{ card: DOMRect; element: HTMLDivElement; side: PortSide; offset: number } | null>(null);
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
  return <div
    className="flow-connector nodrag"
    data-side={position.side}
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
        <span className="flow-connector-label">{label}</span>
      </button>
    ) : <span className="flow-connector-hit" aria-hidden="true"><span className="flow-connector-label">{label}</span></span>}
  </div>;
}

export const wiringNodeTypes = { hardware: HardwareNode };
