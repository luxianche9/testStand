import type { Hardware } from "@teststand/contracts/devices";
import type { PortSide, ProjectCanvasNode, ProjectWiringConnection } from "@teststand/contracts/wiring";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  clampCardHeight,
  clampCardWidth,
  defaultPortPositions,
  splitPortRef,
  type HardwareFlowNode,
  type TopologyEdge
} from "./wiring-model.js";

export type FlowNodeOptions = {
  editingHardwareId?: string | undefined;
  movePort: (hardwareId: string, portId: string, side: PortSide, offset: number) => void;
  resizeNode: (hardwareId: string, width: number, height: number) => void;
};

/** A card for hardware the catalog no longer resolves, so its cables stay visible. */
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
  const width = clampCardWidth(node.width ?? DEFAULT_CARD_WIDTH);
  const height = clampCardHeight(node.height ?? DEFAULT_CARD_HEIGHT);
  return {
    id: node.hardwareId,
    type: "hardware",
    position: { x: node.x, y: node.y },
    width,
    height,
    style: { width, height },
    deletable: false,
    data: {
      hardware: item ?? fallback,
      resolved: Boolean(item),
      // Nodes placed by the Agent or older projects may carry no positions; never stack ports on one spot.
      portPositions: {
        ...defaultPortPositions((item ?? fallback).ports.map((port) => port.portId)),
        ...node.portPositions
      },
      portEditing: options.editingHardwareId === node.hardwareId,
      movePort: options.movePort,
      resizeNode: options.resizeNode
    }
  };
}

/** Same-port pin connections are retained in the document and the 针脚列表 only. */
export function toFlowEdges(
  connections: ReadonlyArray<Pick<ProjectWiringConnection, "connectionId" | "portA" | "portB">>,
  hardware: Hardware[]
): TopologyEdge[] {
  return connections.flatMap((connection) => {
    if (connection.portA === connection.portB) return [];
    const a = splitPortRef(connection.portA, hardware);
    const b = splitPortRef(connection.portB, hardware);
    if (!a || !b) return [];
    return [{
      id: connection.connectionId,
      source: a.hardwareId,
      sourceHandle: a.portId,
      target: b.hardwareId,
      targetHandle: b.portId,
      type: "smoothstep",
      className: "wiring-flow-edge",
      deletable: false,
      data: { connectionId: connection.connectionId }
    }];
  });
}
