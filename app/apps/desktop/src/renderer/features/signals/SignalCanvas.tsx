import { useEffect, useMemo, useRef, type DragEvent } from "react";
import {
  Background, BackgroundVariant, ConnectionLineType, ReactFlow, useEdgesState, useNodesInitialized,
  useNodesState, useReactFlow, type Connection, type Edge, type NodeTypes
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SignalEnd, SignalView, SignalWidget } from "@teststand/contracts/signals";
import { WorkflowIcon } from "lucide-react";
import { cn, useToast } from "../../ui/index.js";
import { HARDWARE_MIME, WIDGET_MIME } from "./dnd.js";
import {
  WIDGET_SIZES, linkProblem, parseHandle, signalsOf, widgetSignals, type Catalog
} from "./signal-model.js";
import {
  HardwareNodeView, WidgetNodeView, type HardwareFlowNode, type SignalFlowNode, type WidgetFlowNode
} from "./SignalNodes.js";
import type { SignalEdits } from "./use-signal-document.js";

const NODE_TYPES: NodeTypes = { hardware: HardwareNodeView, widget: WidgetNodeView } as NodeTypes;
const fitOptions = { padding: 0.15, maxZoom: 1 };

function endOf(nodeId: string | null, handle: string | null | undefined): SignalEnd | undefined {
  if (!nodeId || !handle) return undefined;
  const parsed = parseHandle(handle);
  return { nodeId, handle: parsed.handle, ...(parsed.bit !== undefined ? { bit: parsed.bit } : {}) };
}

function linkClass(view: SignalView, from: SignalEnd, to: SignalEnd): string {
  const kinds = [from, to].map((end) => view.nodes.find((node) => node.nodeId === end.nodeId)?.kind);
  if (kinds[0] === "hardware" && kinds[1] === "hardware") return "link-carrier";
  return kinds[0] === "widget" ? "link-control" : "link-display";
}

/**
 * 信号视图: devices and passive parts with their signals, and the widgets those signals feed or
 * that drive them, as one React Flow canvas. Dropping a hardware row or a widget places it; dragging
 * from a signal to another signal or a widget links them when the signal view rules allow it.
 */
export function SignalCanvas({ view, catalog, online, edits, onInfo, onControl }: {
  view: SignalView;
  catalog: Catalog;
  /** hardwareId → device online (undefined: not checked yet). */
  online: ReadonlyMap<string, boolean>;
  edits: SignalEdits;
  onInfo: (hardwareId: string) => void;
  onControl: (hardwareId: string, anchor: DOMRect) => void;
}) {
  const toast = useToast();
  const flow = useReactFlow<SignalFlowNode, Edge>();
  const latest = useRef({ view, catalog });
  latest.current = { view, catalog };

  const flowNodes = useMemo<SignalFlowNode[]>(() => view.nodes.map((node): SignalFlowNode => {
    if (node.kind === "hardware") {
      const entry = catalog.get(node.hardwareId);
      return {
        id: node.nodeId,
        type: "hardware",
        position: { x: node.x, y: node.y },
        data: {
          node,
          label: entry?.label ?? node.hardwareId,
          kind: entry?.kind ?? "missing",
          unknown: entry?.kind === "managed" && !entry.known,
          online: online.get(node.hardwareId),
          signals: signalsOf(entry),
          onInfo,
          onControl
        }
      } satisfies HardwareFlowNode;
    }
    const size = WIDGET_SIZES[node.widget];
    return {
      id: node.nodeId,
      type: "widget",
      position: { x: node.x, y: node.y },
      width: node.width ?? size.width,
      height: node.height ?? size.height,
      dragHandle: "header",
      data: {
        node,
        inputs: widgetSignals(view, catalog, node.nodeId),
        onRemove: edits.removeNode,
        onRename: (nodeId, label) => edits.updateWidget(nodeId, { label }),
        onResize: edits.resizeNode
      }
    } satisfies WidgetFlowNode;
  }), [view, catalog, online, edits, onInfo, onControl]);
  const flowEdges = useMemo<Edge[]>(() => view.links.map((link) => ({
    id: link.linkId,
    source: link.from.nodeId,
    sourceHandle: link.from.bit === undefined ? link.from.handle : `${link.from.handle}#${link.from.bit}`,
    target: link.to.nodeId,
    targetHandle: link.to.bit === undefined ? link.to.handle : `${link.to.handle}#${link.to.bit}`,
    className: linkClass(view, link.from, link.to)
  })), [view]);

  const [nodes, setNodes, onNodesChange] = useNodesState<SignalFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Keep the selection across document updates; the document owns positions and sizes.
  useEffect(() => setNodes((current) => {
    const selected = new Set(current.filter((node) => node.selected).map((node) => node.id));
    return flowNodes.map((node) => (selected.has(node.id) ? { ...node, selected: true } : node));
  }), [flowNodes, setNodes]);
  useEffect(() => setEdges(flowEdges), [flowEdges, setEdges]);

  const initialized = useNodesInitialized();
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !initialized || !flowNodes.length) return;
    framed.current = true;
    void flow.fitView(fitOptions);
  }, [flow, initialized, flowNodes.length]);

  const toLink = (connection: Connection | Edge) => {
    const from = endOf(connection.source, connection.sourceHandle);
    const to = endOf(connection.target, connection.targetHandle);
    return from && to ? { from, to } : undefined;
  };
  const connect = (connection: Connection) => {
    const link = toLink(connection);
    if (!link) return;
    const problem = linkProblem(latest.current.view, latest.current.catalog, link);
    if (problem) { toast.error(problem); return; }
    edits.addLink(link);
  };
  const valid = (connection: Connection | Edge) => {
    const link = toLink(connection);
    return Boolean(link) && !linkProblem(latest.current.view, latest.current.catalog, link!);
  };

  const place = (widget: SignalWidget, x: number, y: number) => edits.addWidget(widget, x, y);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    framed.current = true;
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const hardwareId = event.dataTransfer.getData(HARDWARE_MIME);
    if (hardwareId) {
      if (view.nodes.some((node) => node.kind === "hardware" && node.hardwareId === hardwareId)) {
        toast.info("这台硬件已经在信号视图上");
        return;
      }
      edits.addHardware(hardwareId, at.x, at.y);
      return;
    }
    const widget = event.dataTransfer.getData(WIDGET_MIME) as SignalWidget;
    if (widget) place(widget, at.x - WIDGET_SIZES[widget].width / 2, at.y - 14);
  };

  return (
    <div
      className="signal-canvas relative h-full min-h-0 min-w-0 bg-canvas"
      onDrop={drop}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    >
      <ReactFlow<SignalFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        isValidConnection={valid}
        connectionLineType={ConnectionLineType.Bezier}
        onNodeDragStop={(_event, _node, dragged) => {
          for (const node of dragged) edits.moveNode(node.id, node.position.x, node.position.y);
        }}
        onNodesDelete={(deleted) => { for (const node of deleted) edits.removeNode(node.id); }}
        onEdgesDelete={(deleted) => edits.removeLinks(deleted.map((edge) => edge.id))}
        deleteKeyCode={["Delete", "Backspace"]}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--tf-canvas-grid)"
          bgColor="var(--tf-canvas)" />
      </ReactFlow>
      {!view.nodes.length && (
        <div className={cn("pointer-events-none absolute inset-0 z-[1] grid place-content-center",
          "justify-items-center gap-2")}>
          <div className="grid size-10 place-items-center rounded-md border border-dashed border-line-strong text-fg-3">
            <WorkflowIcon className="size-4" />
          </div>
          <strong className="text-sm font-medium text-fg">把设备和被测对象从左侧拖到画布</strong>
          <span className="max-w-[340px] text-center text-xs text-fg-3">
            再从左侧控件列表拖入示波器、终端、开关等控件，从信号拖线到控件；也可以「生成默认面板」。
          </span>
        </div>
      )}
    </div>
  );
}

