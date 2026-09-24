import { useMemo } from "react";
import { Background, BackgroundVariant, ConnectionMode, ReactFlow } from "@xyflow/react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { RecentProjectSummary } from "@hardwareharness/contracts/projects";
import { useHardwareImageUrls } from "../../lib/queries.js";
import { wiringNodeTypes } from "./HardwareNode.js";
import { fallbackHardware, toFlowEdges, toFlowNode, type FlowNodeOptions } from "./flow-elements.js";
import type { HardwareFlowNode, TopologyEdge } from "./wiring-model.js";

const noop = () => undefined;

/** Read-only thumbnail of a project's bench, used on the welcome page. */
export function TopologyPreview({ project, hardware, compact }: {
  project: RecentProjectSummary; hardware: Hardware[]; compact: boolean;
}) {
  const imageRefs = useMemo(
    () => hardware
      .filter((item) => project.preview.nodes.some((node) => node.hardwareId === item.hardwareId))
      .map((item) => ({ hardwareId: item.hardwareId, assetId: item.appearanceAssetId })),
    [hardware, project.preview.nodes]
  );
  const imageUrls = useHardwareImageUrls(imageRefs);
  const topology = useMemo(() => buildPreviewTopology(project, hardware, imageUrls), [hardware, imageUrls, project]);
  return (
    <div
      className={compact ? "topology-preview compact" : "topology-preview"}
      role="img"
      aria-label={`${project.name} 工位接线缩略图`}
    >
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
          <Background
            variant={BackgroundVariant.Dots}
            gap={14}
            size={1}
            color="var(--tf-canvas-grid)"
            bgColor="var(--tf-canvas)"
          />
        </ReactFlow>
      ) : <span className="topology-empty">暂无接线数据</span>}
    </div>
  );
}

function buildPreviewTopology(project: RecentProjectSummary, hardware: Hardware[], imageUrls: Record<string, string>) {
  const { nodes: source, connections } = project.preview;
  if (!source.length) return { nodes: [] as HardwareFlowNode[], edges: [] as TopologyEdge[] };
  const options: FlowNodeOptions = { imageUrls, interactive: false, movePort: noop, resizeNode: noop };
  const nodes = source.map((node) => {
    const item = hardware.find((entry) => entry.hardwareId === node.hardwareId);
    const fallback = fallbackHardware(node.hardwareId, portsFromConnections(node.hardwareId, connections));
    return toFlowNode(node, item, fallback, options);
  });
  const edges = toFlowEdges(connections, nodes.map((node) => node.data.hardware), false);
  return { nodes, edges };
}

/** Unregistered devices still draw their connectors, derived from the cables that reference them. */
function portsFromConnections(hardwareId: string, connections: RecentProjectSummary["preview"]["connections"]) {
  const portIds = new Set<string>();
  for (const connection of connections) {
    for (const ref of [connection.portA, connection.portB]) {
      if (ref.startsWith(`${hardwareId}.`)) portIds.add(ref.slice(hardwareId.length + 1));
    }
  }
  return portIds;
}
