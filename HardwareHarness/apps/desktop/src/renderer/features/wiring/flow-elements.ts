import type { Hardware } from "@hardwareharness/contracts/devices";
import type { PortSide, ProjectCanvasNode, ProjectWiringConnection } from "@hardwareharness/contracts/wiring";
import { resolvePortRef } from "../../lib/hardware.js";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  MIN_CARD_HEIGHT_LABEL,
  assetKey,
  clampCardHeight,
  clampCardWidth,
  connectionSignal,
  defaultPortPositions,
  splitPortRef,
  type HardwareFlowNode,
  type TopologyEdge
} from "./wiring-model.js";

/** Shared by the editable canvas and the read-only welcome-page preview. */
export type FlowNodeOptions = {
  imageUrls: Record<string, string>;
  interactive: boolean;
  editingHardwareId?: string | undefined;
  movePort: (hardwareId: string, portId: string, side: PortSide, offset: number) => void;
  resizeNode: (hardwareId: string, width: number, height: number) => void;
};

export function fallbackHardware(hardwareId: string, portIds: Iterable<string> = []): Hardware {
  return {
    formatVersion: 2,
    hardwareId,
    kind: "passive",
    label: hardwareId,
    ports: [...portIds].map((portId) => ({ portId, name: portId, pins: [] }))
  };
}

export function toFlowNode(
  node: ProjectCanvasNode,
  item: Hardware | undefined,
  fallback: Hardware,
  options: FlowNodeOptions
): HardwareFlowNode {
  const showImage = node.showImage !== false;
  const width = clampCardWidth(node.width ?? DEFAULT_CARD_WIDTH);
  const height = clampCardHeight(
    node.height ?? (showImage ? DEFAULT_CARD_HEIGHT : MIN_CARD_HEIGHT_LABEL + 8),
    showImage
  );
  const readOnly = options.interactive ? {} : { draggable: false, selectable: false, focusable: false };
  return {
    id: node.hardwareId,
    type: "hardware",
    position: { x: node.x, y: node.y },
    width,
    height,
    style: { width, height },
    deletable: false,
    ...readOnly,
    data: {
      hardware: item ?? fallback,
      resolved: Boolean(item),
      imageUrl: item?.appearanceAssetId
        ? options.imageUrls[assetKey(item.hardwareId, item.appearanceAssetId)]
        : undefined,
      showImage,
      // Nodes placed by the Agent or older projects may carry no positions; never stack ports on one spot.
      portPositions: {
        ...defaultPortPositions((item ?? fallback).ports.map((port) => port.portId)),
        ...node.portPositions
      },
      portEditing: options.interactive && options.editingHardwareId === node.hardwareId,
      interactive: options.interactive,
      movePort: options.movePort,
      resizeNode: options.resizeNode
    }
  };
}

/** Same-port pin connections are retained in the document and list only. */
export function toFlowEdges(
  connections: ReadonlyArray<Pick<ProjectWiringConnection, "connectionId" | "portA" | "portB">>,
  hardware: Hardware[],
  interactive: boolean
): TopologyEdge[] {
  return connections.flatMap((connection) => {
    if (connection.portA === connection.portB) return [];
    const a = splitPortRef(connection.portA, hardware);
    const b = splitPortRef(connection.portB, hardware);
    if (!a || !b) return [];
    const signal = connectionSignal(
      resolvePortRef(connection.portA, hardware).port,
      resolvePortRef(connection.portB, hardware).port
    );
    const edge: TopologyEdge = {
      id: connection.connectionId,
      source: a.hardwareId,
      sourceHandle: a.portId,
      target: b.hardwareId,
      targetHandle: b.portId,
      type: "smoothstep",
      className: signal ? `wiring-flow-edge signal-${signal}` : "wiring-flow-edge",
      deletable: false,
      data: { connectionId: connection.connectionId, signal }
    };
    return [interactive ? edge : { ...edge, selectable: false, focusable: false }];
  });
}
