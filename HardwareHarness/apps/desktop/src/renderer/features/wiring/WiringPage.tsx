import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider, useEdgesState, useNodesState } from "@xyflow/react";
import { TriangleAlertIcon } from "lucide-react";
import { onAppCommand } from "../../app/commands.js";
import { errorMessage } from "../../lib/errors.js";
import { invalidateWiringData } from "../../lib/mutations.js";
import { useWiringTasks } from "../../lib/queries.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { ConfirmDialog, HeaderTabs, Spinner, Splitter } from "../../ui/index.js";
import { EditPinsModal, ListCreateConnectionModal, ManualConnectionModal } from "./ConnectionEditor.js";
import { HardwareLibrary } from "./HardwareLibrary.js";
import { NodeContextMenu, WiringCanvas, useTransientNodeUi } from "./WiringCanvas.js";
import { ConnectionInspector, WiringList } from "./WiringInspector.js";
import { WiringLogPanel } from "./WiringLogPanel.js";
import { WiringToolbar, type WiringView } from "./WiringToolbar.js";
import { fallbackHardware, toFlowEdges, toFlowNode } from "./flow-elements.js";
import { useWiringDocument } from "./use-wiring-document.js";
import {
  isTaskActionable,
  touchesHardware,
  type HardwareFlowNode,
  type ManualPair,
  type NodeMenu,
  type TopologyEdge
} from "./wiring-model.js";

type SideTab = "library" | "log";

export function WiringPage() {
  return <ReactFlowProvider><WiringWorkbench /></ReactFlowProvider>;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="grid h-full min-h-0 min-w-0 place-items-center overflow-hidden bg-surface-0">{children}</main>
  );
}

function ErrorBanner({ message, className }: { message: string; className?: string }) {
  return (
    <div
      role="alert"
      className={
        "flex items-start gap-2 rounded-md border border-fail/35 bg-fail/8 px-3 py-2 text-xs text-fail "
        + (className ?? "")
      }
    >
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="break-words whitespace-pre-wrap">{message}</span>
    </div>
  );
}

/** Layout changes are saved automatically; structural edits remain in the project buffer. */
function WiringWorkbench() {
  const client = useQueryClient();
  const { project, catalog, save, wiring, hardware, edits } = useWiringDocument();
  const [view, setView] = useState<WiringView>("canvas");
  const [sideTab, setSideTab] = useState<SideTab>("library");
  const tasks = useWiringTasks();
  const library = useResizableWidth({
    storageKey: "hardwareharness.wiring-library-width", defaultWidth: 300, min: 200, max: 520, direction: "right"
  });
  const sidebar = useResizableWidth({
    storageKey: "hardwareharness.wiring-inspector-width", defaultWidth: 300, min: 240, max: 520, direction: "left"
  });
  const [manualPair, setManualPair] = useState<ManualPair>();
  const [listCreateOpen, setListCreateOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string>();
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [nodeMenu, setNodeMenu] = useState<NodeMenu>();
  const [pendingRemoveHardwareId, setPendingRemoveHardwareId] = useState<string>();
  const [editingPortHardwareId, setEditingPortHardwareId] = useState<string>();
  const [nodes, setNodes, onNodesChange] = useNodesState<HardwareFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyEdge>([]);

  const connections = useMemo(() => wiring?.connections ?? [], [wiring?.connections]);
  const { movePort, resizeNode } = edits;

  const flowNodes = useMemo(() => (wiring?.nodes ?? []).map((node) => toFlowNode(
    node,
    hardware.find((entry) => entry.hardwareId === node.hardwareId),
    fallbackHardware(node.hardwareId),
    { interactive: true, editingHardwareId: editingPortHardwareId, movePort, resizeNode }
  )), [editingPortHardwareId, hardware, movePort, resizeNode, wiring?.nodes]);
  const flowEdges = useMemo(
    () => toFlowEdges(connections, hardware, true)
      .map((edge) => ({ ...edge, selected: edge.id === selectedConnectionId })),
    [connections, hardware, selectedConnectionId]
  );

  useEffect(() => setNodes(flowNodes), [flowNodes, setNodes]);
  useEffect(() => setEdges(flowEdges), [flowEdges, setEdges]);
  useEffect(() => {
    if (selectedConnectionId && !connections.some((item) => item.connectionId === selectedConnectionId)) {
      setSelectedConnectionId(undefined);
    }
  }, [connections, selectedConnectionId]);
  useEffect(() => onAppCommand("wiring.new-connection", () => setListCreateOpen(true)), []);

  const closeMenu = useCallback(() => setNodeMenu(undefined), []);
  const stopEditing = useCallback(() => setEditingPortHardwareId(undefined), []);
  useTransientNodeUi({ menu: nodeMenu, editingHardwareId: editingPortHardwareId, closeMenu, stopEditing });

  const requestRemoveNode = (hardwareId: string) => {
    setEditingPortHardwareId((current) => current === hardwareId ? undefined : current);
    if (connections.some((entry) => touchesHardware(entry, hardwareId))) setPendingRemoveHardwareId(hardwareId);
    else edits.removeNode(hardwareId);
  };

  if (project.isError) {
    return <Centered><ErrorBanner className="max-w-[560px]" message={errorMessage(project.error)} /></Centered>;
  }
  if (project.isLoading || catalog.isLoading || !wiring) {
    return <Centered><Spinner label="正在加载接线画布" /></Centered>;
  }

  const selectedConnection = connections.find((item) => item.connectionId === selectedConnectionId);
  const editingConnection = connections.find((item) => item.connectionId === editingConnectionId);
  const pendingLabel = hardware.find((item) => item.hardwareId === pendingRemoveHardwareId)?.label
    ?? pendingRemoveHardwareId;
  const inspecting = view === "canvas" ? selectedConnection : undefined;
  const allTasks = tasks.data ?? [];
  const pendingTaskCount = allTasks.filter(isTaskActionable).length;
  const sideTabs = (actions?: ReactNode) => (
    <HeaderTabs<SideTab>
      label="接线侧栏"
      idPrefix="wiring-side"
      value={sideTab}
      onChange={setSideTab}
      actions={actions}
      options={[
        { value: "library", label: "硬件库", meta: hardware.length },
        {
          value: "log",
          label: "接线日志",
          meta: pendingTaskCount > 0
            ? <span className="rounded-xs bg-signal px-1 font-semibold text-signal-fg">{pendingTaskCount}</span>
            : allTasks.length
        }
      ]}
    />
  );

  return (
    <main className="h-full min-h-0 min-w-0 overflow-hidden bg-surface-0">
      <section
        className="grid h-full"
        style={{
          gridTemplateColumns: `${library.width}px 1px minmax(0, 1fr)`
            + (inspecting ? ` 1px ${sidebar.width}px` : "")
        }}
      >
        {/* The left column switches between the hardware library and the wiring log. */}
        {sideTab === "library" ? (
          <HardwareLibrary
            id="wiring-side-library"
            role="tabpanel"
            header={sideTabs}
            hardware={hardware}
            placed={new Set(wiring.nodes.map((node) => node.hardwareId))}
            onAdd={(hardwareId) => edits.addNode(hardwareId)}
            onRefresh={() => void invalidateWiringData(client)}
          />
        ) : (
          <WiringLogPanel id="wiring-side-log" role="tabpanel" header={sideTabs()} hardware={hardware} />
        )}
        <Splitter label="调整侧栏宽度" {...library.separatorProps} />
        <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <WiringToolbar
            view={view}
            onViewChange={setView}
            nodeCount={wiring.nodes.length}
            connectionCount={connections.length}
            saving={save.isPending}
            onCreate={() => setListCreateOpen(true)}
          />
          <div className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)]">
            {save.isError && (
              <ErrorBanner
                className="absolute top-2 right-3 left-3 z-20 shadow-overlay"
                message={errorMessage(save.error)}
              />
            )}
            {view === "canvas" ? (
              <WiringCanvas
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={setManualPair}
                onDropHardware={edits.addNode}
                onMoveNode={edits.moveNode}
                onSelectConnection={setSelectedConnectionId}
                onNodeMenu={setNodeMenu}
              />
            ) : (
              <div className="min-h-0">
                <WiringList
                  connections={connections}
                  hardware={hardware}
                  onRemove={edits.removeConnection}
                  removing={save.isPending}
                  onEdit={setEditingConnectionId}
                />
              </div>
            )}
          </div>
        </section>
        {/* A selected cable opens its inspector on the right; otherwise the canvas takes the width. */}
        {inspecting && <>
          <Splitter label="调整接线属性栏宽度" {...sidebar.separatorProps} />
          <ConnectionInspector
            connection={inspecting}
            hardware={hardware}
            onClose={() => setSelectedConnectionId(undefined)}
            onEdit={() => setEditingConnectionId(inspecting.connectionId)}
            onRemove={edits.removeConnection}
            removing={save.isPending}
          />
        </>}
      </section>

      {nodeMenu && (
        <NodeContextMenu
          menu={nodeMenu}
          onEditPorts={() => { setEditingPortHardwareId(nodeMenu.hardwareId); setNodeMenu(undefined); }}
          onRemove={() => { setNodeMenu(undefined); requestRemoveNode(nodeMenu.hardwareId); }}
        />
      )}
      <ManualConnectionModal
        pair={manualPair}
        hardware={hardware}
        existing={connections}
        onClose={() => setManualPair(undefined)}
        onCreate={(portA, portB, pins) => { edits.createConnection(portA, portB, pins); setManualPair(undefined); }}
      />
      <ListCreateConnectionModal
        open={listCreateOpen}
        hardware={hardware}
        existing={connections}
        onClose={() => setListCreateOpen(false)}
        onCreate={(portA, portB, pins) => { edits.createConnection(portA, portB, pins); setListCreateOpen(false); }}
      />
      <EditPinsModal
        connection={editingConnection}
        hardware={hardware}
        onClose={() => setEditingConnectionId(undefined)}
        onSave={(connectionId, pins) => {
          edits.updateConnectionPins(connectionId, pins);
          setEditingConnectionId(undefined);
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingRemoveHardwareId)}
        title="移除画布节点"
        message={`${pendingLabel} 上还有已确认的接线。移除画布节点会同时删除这些接线记录。`}
        confirmLabel="移除并删除接线"
        danger
        onConfirm={() => {
          if (pendingRemoveHardwareId) edits.removeNode(pendingRemoveHardwareId);
          setPendingRemoveHardwareId(undefined);
        }}
        onCancel={() => setPendingRemoveHardwareId(undefined)}
      />
    </main>
  );
}
