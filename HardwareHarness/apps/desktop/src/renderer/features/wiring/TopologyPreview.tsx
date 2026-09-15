import { useMemo } from "react";
import { Background, BackgroundVariant, ConnectionMode, ReactFlow } from "@xyflow/react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { RecentProjectSummary } from "@hardwareharness/contracts/projects";
import { wiringNodeTypes } from "./WiringCanvas.js";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  MIN_CARD_HEIGHT_LABEL,
  clampCardHeight,
  clampCardWidth,
  splitPortRef,
  type HardwareFlowNode,
  type TopologyEdge
} from "./wiring-model.js";

const noopMovePort = () => undefined;
const noopResizeNode = () => undefined;

export function TopologyPreview({ project, hardware, compact }: { project: RecentProjectSummary; hardware: Hardware[]; compact: boolean }) {
  const topology = useMemo(() => buildPreviewTopology(project, hardware), [hardware, project]);
  return (
    <div className={`topology-preview${compact ? " compact" : ""}`} role="img" aria-label={`${project.name} 工位接线缩略图`}>
      {topology.nodes.length ? (
        <ReactFlow<HardwareFlowNode, TopologyEdge>
          nodes={topology.nodes}
          edges={topology.edges}
          nodeTypes={wiringNodeTypes}
          connectionMode={ConnectionMode.Loose}
          fitView
          fitViewOptions={{ padding: compact ? 0.08 : 0.16, minZoom: 0.1, maxZoom: compact ? 0.75 : 1 }}
          minZoom={0.1}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          disableKeyboardA11y
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--tf-canvas-grid)" bgColor="var(--tf-canvas)" />
        </ReactFlow>
      ) : <span className="topology-empty">暂无接线数据</span>}
    </div>
  );
}

function buildPreviewTopology(project: RecentProjectSummary, hardware: Hardware[]) {
  const source = project.preview.nodes;
  if (!source.length) return { nodes: [] as HardwareFlowNode[], edges: [] as TopologyEdge[] };
  const nodes: HardwareFlowNode[] = source.map((node) => {
    const item = hardware.find((entry) => entry.hardwareId === node.hardwareId);
    const showImage = node.showImage !== false;
    const width = clampCardWidth(node.width ?? DEFAULT_CARD_WIDTH);
    const height = clampCardHeight(node.height ?? (showImage ? DEFAULT_CARD_HEIGHT : MIN_CARD_HEIGHT_LABEL + 8), showImage);
    return {
      id: node.hardwareId,
      type: "hardware",
      position: { x: node.x, y: node.y },
      width,
      height,
      style: { width, height },
      draggable: false,
      selectable: false,
      focusable: false,
      deletable: false,
      data: {
        hardware: item ?? unresolvedHardware(node.hardwareId, project.preview.connections),
        resolved: Boolean(item),
        imageUrl: item?.appearanceAssetId ? hardwareImageUrl(item.hardwareId, item.appearanceAssetId) : undefined,
        showImage,
        portPositions: node.portPositions,
        portEditing: false,
        interactive: false,
        movePort: noopMovePort,
        resizeNode: noopResizeNode
      }
    };
  });
  const edges: TopologyEdge[] = project.preview.connections.flatMap((connection) => {
    if (connection.portA === connection.portB) return [];
    const a = splitPortRef(connection.portA, nodes.map((node) => node.data.hardware));
    const b = splitPortRef(connection.portB, nodes.map((node) => node.data.hardware));
    if (!a || !b) return [];
    return [{
      id: connection.connectionId,
      source: a.hardwareId,
      sourceHandle: a.portId,
      target: b.hardwareId,
      targetHandle: b.portId,
      type: "step",
      className: "wiring-flow-edge",
      selectable: false,
      focusable: false,
      deletable: false,
      data: { connectionId: connection.connectionId }
    }];
  });
  return { nodes, edges };
}

function unresolvedHardware(hardwareId: string, connections: RecentProjectSummary["preview"]["connections"]): Hardware {
  const portIds = new Set<string>();
  for (const connection of connections) {
    for (const ref of [connection.portA, connection.portB]) {
      if (ref.startsWith(`${hardwareId}.`)) portIds.add(ref.slice(hardwareId.length + 1));
    }
  }
  return {
    formatVersion: 2,
    hardwareId,
    kind: "passive",
    label: hardwareId,
    ports: [...portIds].map((portId) => ({ portId, name: portId, pins: [] }))
  };
}

function hardwareImageUrl(hardwareId: string, assetId: string) {
  return `hardwareharness-asset://local/${encodeURIComponent(hardwareId)}/${assetId.split("/").map(encodeURIComponent).join("/")}`;
}
