import { useEffect, useRef, type DragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type OnEdgesChange,
  type OnNodesChange
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CableIcon } from "lucide-react";
import { cn } from "../../ui/index.js";
import { HARDWARE_MIME } from "./HardwareLibrary.js";
import { wiringNodeTypes } from "./HardwareNode.js";
import type { HardwareFlowNode, ManualPair, NodeMenu, TopologyEdge } from "./wiring-model.js";

const fitOptions = { padding: 0.2, maxZoom: 1 };

/** The bench: dotted canvas, faceplate nodes, signal-coloured cables. */
export function WiringCanvas({
  nodes, edges, onNodesChange, onEdgesChange, onConnect, onDropHardware, onMoveNode,
  onSelectConnection, onNodeMenu
}: {
  nodes: HardwareFlowNode[];
  edges: TopologyEdge[];
  onNodesChange: OnNodesChange<HardwareFlowNode>;
  onEdgesChange: OnEdgesChange<TopologyEdge>;
  onConnect: (pair: ManualPair) => void;
  onDropHardware: (hardwareId: string, position: { x: number; y: number }) => void;
  onMoveNode: (hardwareId: string, x: number, y: number) => void;
  onSelectConnection: (connectionId: string | undefined) => void;
  onNodeMenu: (menu: NodeMenu) => void;
}) {
  const flow = useReactFlow<HardwareFlowNode, TopologyEdge>();
  // Frame the bench once every node loaded from the project has been measured.
  const nodesInitialized = useNodesInitialized();
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !nodesInitialized || !nodes.length) return;
    framed.current = true;
    void flow.fitView(fitOptions);
  }, [flow, nodesInitialized, nodes.length]);

  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const portA = `${connection.source}.${connection.sourceHandle}`;
    const portB = `${connection.target}.${connection.targetHandle}`;
    if (portA !== portB) onConnect({ portA, portB });
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    const hardwareId = event.dataTransfer.getData(HARDWARE_MIME);
    if (hardwareId) onDropHardware(hardwareId, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  return (
    <div
      className="wiring-canvas relative h-full min-h-0 min-w-0 bg-canvas"
      onDrop={drop}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
    >
      <ReactFlow<HardwareFlowNode, TopologyEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={wiringNodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionMode={ConnectionMode.Loose}
        onNodeDragStop={(_event, node) => onMoveNode(node.id, node.position.x, node.position.y)}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          onNodeMenu({
            hardwareId: node.id,
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 140))
          });
        }}
        onEdgeClick={(_event, edge) => onSelectConnection(String(edge.data?.connectionId ?? edge.id))}
        onPaneClick={() => onSelectConnection(undefined)}
        fitView
        fitViewOptions={fitOptions}
        minZoom={0.3}
        maxZoom={2}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          id="minor"
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1.2}
          color="var(--tf-canvas-grid)"
          bgColor="var(--tf-canvas)"
        />
        <Background
          id="major"
          variant={BackgroundVariant.Lines}
          gap={160}
          lineWidth={1}
          color="var(--tf-canvas-grid)"
          bgColor="transparent"
        />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      {!nodes.length && (
        <div
          className="pointer-events-none absolute inset-0 z-[1] grid place-content-center justify-items-center gap-2"
        >
          <div className="grid size-10 place-items-center rounded-md border border-dashed border-line-strong text-fg-3">
            <CableIcon className="size-4" />
          </div>
          <strong className="text-sm font-medium text-fg">把设备从左侧拖到画布</strong>
          <span className="max-w-[300px] text-center text-xs text-fg-3">
            画布是工程文档，加入节点不会调用远端硬件。
          </span>
        </div>
      )}
    </div>
  );
}

/** Right-click menu for one node. Focuses its first item so the keyboard can drive it. */
export function NodeContextMenu({ menu, showingImage, onEditPorts, onToggleImage, onRemove }: {
  menu: NodeMenu;
  showingImage: boolean;
  onEditPorts: () => void;
  onToggleImage: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus(); }, [menu]);
  const itemClass = cn(
    "flex h-7 w-full items-center rounded-sm px-2 text-left text-sm whitespace-nowrap text-fg outline-none",
    "transition-colors duration-120 hover:bg-surface-3 focus-visible:bg-surface-3"
  );
  return (
    <div
      ref={ref}
      className={cn(
        "wiring-node-menu fixed z-30 grid w-[168px] animate-fade-in gap-px rounded-md border border-line-strong",
        "bg-surface-2 p-1 shadow-overlay"
      )}
      role="menu"
      aria-label="硬件操作"
      style={{ left: menu.x, top: menu.y }}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={onEditPorts}>改变端口位置</button>
      <button type="button" role="menuitem" className={itemClass} onClick={onToggleImage}>
        {showingImage ? "隐藏图片" : "显示图片"}
      </button>
      <div role="separator" className="my-0.5 h-px bg-line" />
      <button
        type="button"
        role="menuitem"
        className={cn(itemClass, "text-fail hover:bg-fail/12 focus-visible:bg-fail/12")}
        onClick={onRemove}
      >
        从画布移除
      </button>
    </div>
  );
}

/** Closes the node menu and leaves port-editing mode on Escape or a pointer press elsewhere.
 *  Presses on the editing node's own connectors keep editing alive so several ports can be moved. */
export function useTransientNodeUi({ menu, editingHardwareId, closeMenu, stopEditing }: {
  menu: NodeMenu | undefined;
  editingHardwareId: string | undefined;
  closeMenu: () => void;
  stopEditing: () => void;
}) {
  useEffect(() => {
    if (!editingHardwareId && !menu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) { closeMenu(); stopEditing(); return; }
      if (target.closest(".wiring-node-menu")) return;
      const portNode = target.closest(".flow-connector-hit")?.closest<HTMLElement>(".flow-hardware-node");
      closeMenu();
      if (editingHardwareId && portNode?.dataset.hardwareId === editingHardwareId) return;
      stopEditing();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeMenu();
      stopEditing();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMenu, editingHardwareId, menu, stopEditing]);
}
