import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection
} from "@xyflow/react";
import { SmartSmoothStepEdge } from "@tisoap/react-flow-smart-edge";
import "@xyflow/react/dist/style.css";
import type { Hardware } from "@testforge/contracts/devices";
import type { PinPair, PortPosition, PortSide, ProjectWiring } from "@testforge/contracts/wiring";
import { errorMessage } from "../../shared/errors.js";
import { IconAlert, IconChip } from "../../shared/icons.js";
import { Btn, Modal, Spinner } from "../../shared/ui.js";
import { useDeviceCatalog, useWiringTasks } from "../../shared/queries.js";
import { invalidateWiringData } from "../../shared/mutations.js";
import { queryKeys } from "../../shared/query-keys.js";
import { useResizableWidth } from "../../shared/resizable.js";
import { HardwareLibrary, wiringNodeTypes } from "./WiringCanvas.js";
import { ConnectionDrawer, WiringList } from "./WiringInspector.js";
import { EditPinsModal, ListCreateConnectionModal, ManualConnectionModal } from "./ConnectionEditor.js";
import { WiringTaskModal } from "./WiringTaskPanel.js";
import { WiringViewSwitch, type WiringView } from "./WiringToolbar.js";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  MIN_CARD_HEIGHT_LABEL,
  assetKey,
  clampCardHeight,
  clampCardWidth,
  clampOffset,
  defaultPortPositions,
  splitPortRef,
  touchesHardware,
  type HardwareFlowNode,
  type ManualPair,
  type NodeMenu,
  type TopologyEdge
} from "./wiring-model.js";

const edgeTypes = { smart: SmartSmoothStepEdge };

export function WiringPage() {
  return <ReactFlowProvider><WiringWorkbench /></ReactFlowProvider>;
}

/** Edits push into the main-process project buffer and mark the document dirty; disk write is explicit. */
function useWiringData() {
  const client = useQueryClient();
  const project = useQuery({ queryKey: queryKeys.projectDocument, queryFn: () => window.testforge.projects.current() });
  const catalog = useDeviceCatalog();
  // wiringTask/project 事件的订阅在 AppShell 全局进行，这里只读共享缓存。
  const tasks = useWiringTasks();

  const save = useMutation({
    mutationFn: (next: ProjectWiring) => window.testforge.wiring.update(next),
    onSuccess: (doc) => { client.setQueryData(queryKeys.projectDocument, doc); }
  });

  const wiringDoc = {
    ...project,
    data: project.data ? { wiring: project.data.file.wiring } : undefined
  };

  return { wiringDoc, catalog, tasks, save };
}

function WiringWorkbench() {
  const client = useQueryClient();
  const { wiringDoc, catalog, tasks, save } = useWiringData();
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const library = useResizableWidth({ defaultWidth: 300, min: 200, max: 520, direction: "right" });
  const [manualPair, setManualPair] = useState<ManualPair>();
  const [listCreateOpen, setListCreateOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string>();
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [nodeMenu, setNodeMenu] = useState<NodeMenu>();
  const [pendingRemoveHardwareId, setPendingRemoveHardwareId] = useState<string>();
  const [editingPortHardwareId, setEditingPortHardwareId] = useState<string>();
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [nodes, setNodes, onNodesChange] = useNodesState<HardwareFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyEdge>([]);
  const flow = useReactFlow<HardwareFlowNode, TopologyEdge>();

  const wiring = wiringDoc.data?.wiring;
  const hardware = useMemo(() => catalog.data?.hardware ?? [], [catalog.data]);
  const taskList = useMemo(() => tasks.data ?? [], [tasks.data]);

  // `useMutation` returns a fresh object every render, but `mutate` is referentially stable.
  // Depending on the object here would churn every memo below it and loop `setNodes`.
  const saveWiring = save.mutate;
  const persist = useCallback((next: ProjectWiring) => saveWiring(next), [saveWiring]);

  const addNode = useCallback((hardwareId: string, position?: { x: number; y: number }) => {
    if (!wiring || wiring.nodes.some((item) => item.hardwareId === hardwareId)) return;
    const index = wiring.nodes.length;
    const ports = hardware.find((item) => item.hardwareId === hardwareId)?.ports.map((item) => item.portId) ?? [];
    persist({
      ...wiring,
      nodes: [...wiring.nodes, {
        hardwareId,
        x: position?.x ?? 80 + (index % 3) * 330,
        y: position?.y ?? 80 + Math.floor(index / 3) * 240,
        width: DEFAULT_CARD_WIDTH,
        height: DEFAULT_CARD_HEIGHT,
        showImage: true,
        portPositions: defaultPortPositions(ports)
      }]
    });
  }, [hardware, persist, wiring]);

  const commitRemoveNode = useCallback((hardwareId: string) => {
    if (!wiring) return;
    persist({
      ...wiring,
      nodes: wiring.nodes.filter((entry) => entry.hardwareId !== hardwareId),
      connections: wiring.connections.filter((entry) => !touchesHardware(entry, hardwareId))
    });
    setPendingRemoveHardwareId(undefined);
  }, [persist, wiring]);

  const removeNode = useCallback((hardwareId: string) => {
    if (!wiring) return;
    const referenced = wiring.connections.some((entry) => touchesHardware(entry, hardwareId));
    if (referenced) {
      setPendingRemoveHardwareId(hardwareId);
      return;
    }
    commitRemoveNode(hardwareId);
  }, [commitRemoveNode, wiring]);

  const movePort = useCallback((hardwareId: string, portId: string, side: PortSide, offset: number) => {
    if (!wiring) return;
    persist({
      ...wiring,
      nodes: wiring.nodes.map((node) => node.hardwareId === hardwareId
        ? { ...node, portPositions: { ...node.portPositions, [portId]: { side, offset: clampOffset(offset) } } }
        : node)
    });
  }, [persist, wiring]);

  const resizeNode = useCallback((hardwareId: string, width: number, height: number) => {
    if (!wiring) return;
    const nextWidth = clampCardWidth(width);
    const nextHeight = clampCardHeight(height, wiring.nodes.find((node) => node.hardwareId === hardwareId)?.showImage !== false);
    persist({
      ...wiring,
      nodes: wiring.nodes.map((node) => node.hardwareId === hardwareId
        ? { ...node, width: nextWidth, height: nextHeight }
        : node)
    });
  }, [persist, wiring]);

  const toggleNodeImage = useCallback((hardwareId: string) => {
    if (!wiring) return;
    persist({
      ...wiring,
      nodes: wiring.nodes.map((node) => {
        if (node.hardwareId !== hardwareId) return node;
        const showImage = node.showImage === false;
        const width = node.width ?? DEFAULT_CARD_WIDTH;
        // Collapse to a label strip when hiding the image; restore a usable card when showing it again.
        const height = showImage
          ? Math.max(node.height ?? DEFAULT_CARD_HEIGHT, DEFAULT_CARD_HEIGHT)
          : Math.min(node.height ?? MIN_CARD_HEIGHT_LABEL, MIN_CARD_HEIGHT_LABEL + 8);
        return { ...node, showImage, width, height };
      })
    });
  }, [persist, wiring]);

  const removeConnection = useCallback((connectionId: string) => {
    if (!wiring) return;
    persist({ ...wiring, connections: wiring.connections.filter((item) => item.connectionId !== connectionId) });
  }, [persist, wiring]);

  const createConnection = useCallback((portA: string, portB: string, pins: PinPair[]) => {
    if (!wiring) return;
    persist({
      ...wiring,
      connections: [...wiring.connections, {
        connectionId: crypto.randomUUID(), portA, portB, pins,
        confirmedAt: new Date().toISOString(), confirmedBy: "user"
      }]
    });
  }, [persist, wiring]);

  const updateConnectionPins = useCallback((connectionId: string, pins: PinPair[]) => {
    if (!wiring) return;
    persist({
      ...wiring,
      connections: wiring.connections.map((item) => item.connectionId === connectionId ? { ...item, pins } : item)
    });
  }, [persist, wiring]);

  const rememberAssetUrl = useCallback((assetId: string, url: string) => setAssetUrls((current) => ({ ...current, [assetId]: url })), []);

  // Appearance images are resolved lazily and cached. The key carries the hardwareId because an
  // assetId like `appearance.png` is only unique inside one device's directory.
  useEffect(() => {
    const missing = hardware.flatMap((item) => item.appearanceAssetId && assetUrls[assetKey(item.hardwareId, item.appearanceAssetId)] === undefined
      ? [[item.hardwareId, item.appearanceAssetId] as const]
      : []);
    if (!missing.length) return;
    void Promise.all(missing.map(async ([hardwareId, assetId]) =>
      [assetKey(hardwareId, assetId), await window.testforge.devices.hardwareImageUrl(hardwareId, assetId)] as const))
      .then((items) => setAssetUrls((current) => ({ ...current, ...Object.fromEntries(items) })));
  }, [assetUrls, hardware]);

  const connections = useMemo(() => wiring?.connections ?? [], [wiring?.connections]);

  const flowNodes = useMemo<HardwareFlowNode[]>(() => (wiring?.nodes ?? []).map((node) => {
    const item = hardware.find((entry) => entry.hardwareId === node.hardwareId);
    const timestamp = new Date(0).toISOString();
    const showImage = node.showImage !== false;
    const width = clampCardWidth(node.width ?? DEFAULT_CARD_WIDTH);
    const height = clampCardHeight(node.height ?? (showImage ? DEFAULT_CARD_HEIGHT : MIN_CARD_HEIGHT_LABEL + 8), showImage);
    return {
      id: node.hardwareId,
      type: "hardware" as const,
      position: { x: node.x, y: node.y },
      width,
      height,
      style: { width, height },
      deletable: false,
      data: {
        hardware: item ?? { formatVersion: 2, hardwareId: node.hardwareId, kind: "passive" as const, label: node.hardwareId, ports: [] },
        resolved: Boolean(item),
        imageUrl: item?.appearanceAssetId ? assetUrls[assetKey(item.hardwareId, item.appearanceAssetId)] : undefined,
        showImage,
        portPositions: node.portPositions,
        portEditing: editingPortHardwareId === node.hardwareId,
        movePort,
        resizeNode
      }
    };
  }), [assetUrls, editingPortHardwareId, hardware, movePort, resizeNode, wiring?.nodes]);

  // One record is one cable is one edge — no grouping step, because the document already stores
  // the connection at the port level the canvas draws at.
  const flowEdges = useMemo<TopologyEdge[]>(() => connections.flatMap((connection) => {
    const a = splitPortRef(connection.portA, hardware);
    const b = splitPortRef(connection.portB, hardware);
    if (!a || !b) return [];
    return [{
      id: connection.connectionId,
      source: a.hardwareId,
      sourceHandle: a.portId,
      target: b.hardwareId,
      targetHandle: b.portId,
      type: "smart",
      className: "wiring-flow-edge",
      deletable: false,
      data: { connectionId: connection.connectionId }
    }];
  }), [connections, hardware]);

  useEffect(() => setNodes(flowNodes), [flowNodes, setNodes]);
  useEffect(() => setEdges(flowEdges), [flowEdges, setEdges]);
  useEffect(() => {
    if (selectedConnectionId && !connections.some((item) => item.connectionId === selectedConnectionId)) setSelectedConnectionId(undefined);
  }, [connections, selectedConnectionId]);
  useEffect(() => {
    if (!editingPortHardwareId && !nodeMenu) return;
    const closeTransientNodeUi = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) { setNodeMenu(undefined); setEditingPortHardwareId(undefined); return; }
      if (target.closest(".wiring-node-menu")) return;
      const portNode = target.closest(".flow-connector-label")?.closest<HTMLElement>(".flow-hardware-node");
      if (editingPortHardwareId && portNode?.dataset.hardwareId === editingPortHardwareId) { setNodeMenu(undefined); return; }
      setNodeMenu(undefined);
      setEditingPortHardwareId(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setNodeMenu(undefined);
      setEditingPortHardwareId(undefined);
    };
    window.document.addEventListener("pointerdown", closeTransientNodeUi, true);
    window.document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.document.removeEventListener("pointerdown", closeTransientNodeUi, true);
      window.document.removeEventListener("keydown", closeOnEscape);
    };
  }, [editingPortHardwareId, nodeMenu]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const portA = `${connection.source}.${connection.sourceHandle}`;
    const portB = `${connection.target}.${connection.targetHandle}`;
    if (portA === portB) return;
    setManualPair({ portA, portB });
  }, []);
  const onDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    const hardwareId = event.dataTransfer.getData("application/testforge-hardware");
    if (!hardwareId) return;
    addNode(hardwareId, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [addNode, flow]);

  const refreshAll = useCallback(async () => invalidateWiringData(client), [client]);

  if (wiringDoc.isLoading || catalog.isLoading || !wiring) return <main className="wiring-page wiring-loading"><Spinner label="正在加载接线画布" /></main>;
  if (wiringDoc.isError) return <main className="wiring-page wiring-loading"><div className="alert"><IconAlert size={16} />{errorMessage(wiringDoc.error)}</div></main>;

  const selectedConnection = connections.find((item) => item.connectionId === selectedConnectionId);
  const editingConnection = connections.find((item) => item.connectionId === editingConnectionId);
  const activeTask = taskList.find((task) => task.status === "in_progress");

  return (
    <main className="wiring-page">
      <section className="wiring-workbench flow-layout" style={{ gridTemplateColumns: `${library.width}px 5px minmax(0, 1fr)` }}>
        <HardwareLibrary
          hardware={hardware}
          assetUrls={assetUrls}
          placed={new Set(wiring.nodes.map((node) => node.hardwareId))}
          onAdd={addNode}
          onRefresh={() => void refreshAll()}
        />
        <div className="col-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整硬件库宽度" title="拖拽调整宽度" {...library.handleProps} />
        <section className="flow-main">
          {save.isError && <div className="flow-inline-error alert"><IconAlert size={15} />{errorMessage(save.error)}</div>}
          <div className={view === "canvas" ? "react-flow-wrap" : "wiring-list-wrap"} onDrop={view === "canvas" ? onDrop : undefined} onDragOver={view === "canvas" ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } : undefined}>
            <WiringViewSwitch view={view} onChange={setView} />
            {view === "canvas" ? (
              <>
                <ReactFlow<HardwareFlowNode, TopologyEdge>
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={wiringNodeTypes}
                  edgeTypes={edgeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  connectionMode={ConnectionMode.Loose}
                  onNodeDragStop={(_event, node) => persist({ ...wiring, nodes: wiring.nodes.map((item) => item.hardwareId === node.id ? { ...item, x: node.position.x, y: node.position.y } : item) })}
                  onNodeContextMenu={(event, node) => {
                    event.preventDefault();
                    setNodeMenu({
                      hardwareId: node.id,
                      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)),
                      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 140))
                    });
                  }}
                  onEdgeClick={(_event, edge) => setSelectedConnectionId(String(edge.data?.connectionId ?? edge.id))}
                  fitView
                  minZoom={0.3}
                  maxZoom={2}
                  deleteKeyCode={null}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--canvas-grid)" bgColor="var(--canvas-bg)" />
                  <Controls position="bottom-right" showInteractive={false} />
                  {!nodes.length && <div className="flow-empty"><IconChip size={28} /><strong>从左侧硬件库拖入设备</strong><span>画布是工程文档，加入节点不会调用远端硬件。</span></div>}
                </ReactFlow>
                {selectedConnection && <ConnectionDrawer connection={selectedConnection} hardware={hardware} onClose={() => setSelectedConnectionId(undefined)} onEdit={() => setEditingConnectionId(selectedConnection.connectionId)} onRemove={removeConnection} removing={save.isPending} />}
                {nodeMenu && (() => {
                  const menuNode = wiring.nodes.find((item) => item.hardwareId === nodeMenu.hardwareId);
                  const showingImage = menuNode?.showImage !== false;
                  return <div className="wiring-node-menu" role="menu" aria-label="硬件操作" style={{ left: nodeMenu.x, top: nodeMenu.y }}>
                    <button type="button" role="menuitem" onClick={() => { setEditingPortHardwareId(nodeMenu.hardwareId); setNodeMenu(undefined); }}>改变端口位置</button>
                    <button type="button" role="menuitem" onClick={() => {
                      const hardwareId = nodeMenu.hardwareId;
                      setNodeMenu(undefined);
                      toggleNodeImage(hardwareId);
                    }}>{showingImage ? "隐藏图片" : "显示图片"}</button>
                    <button type="button" role="menuitem" className="danger" onClick={() => {
                      const hardwareId = nodeMenu.hardwareId;
                      setNodeMenu(undefined);
                      setEditingPortHardwareId((current) => current === hardwareId ? undefined : current);
                      removeNode(hardwareId);
                    }}>从画布移除</button>
                  </div>;
                })()}
              </>
            ) : <WiringList connections={connections} hardware={hardware} onRemove={removeConnection} removing={save.isPending} onCreate={() => setListCreateOpen(true)} onEdit={(connectionId) => setEditingConnectionId(connectionId)} />}
          </div>
        </section>
      </section>

      {activeTask && <WiringTaskModal task={activeTask} hardware={hardware} assetUrls={assetUrls} onAssetUrl={rememberAssetUrl} onChanged={refreshAll} />}
      <ManualConnectionModal
        pair={manualPair}
        hardware={hardware}
        existing={connections}
        onClose={() => setManualPair(undefined)}
        onCreate={(portA, portB, pins) => { createConnection(portA, portB, pins); setManualPair(undefined); }}
      />
      <ListCreateConnectionModal
        open={listCreateOpen}
        hardware={hardware}
        existing={connections}
        onClose={() => setListCreateOpen(false)}
        onCreate={(portA, portB, pins) => { createConnection(portA, portB, pins); setListCreateOpen(false); }}
      />
      <EditPinsModal
        connection={editingConnection}
        hardware={hardware}
        onClose={() => setEditingConnectionId(undefined)}
        onSave={(connectionId, pins) => { updateConnectionPins(connectionId, pins); setEditingConnectionId(undefined); }}
      />
      <Modal
        open={Boolean(pendingRemoveHardwareId)}
        onClose={() => setPendingRemoveHardwareId(undefined)}
        title="移除画布节点"
        footer={<>
          <Btn onClick={() => setPendingRemoveHardwareId(undefined)}>取消</Btn>
          <Btn variant="danger" onClick={() => { if (pendingRemoveHardwareId) commitRemoveNode(pendingRemoveHardwareId); }}>移除并删除接线</Btn>
        </>}
      >
        <p>{hardware.find((item) => item.hardwareId === pendingRemoveHardwareId)?.label ?? pendingRemoveHardwareId} 上还有已确认的接线。移除画布节点会同时删除这些接线记录。</p>
      </Modal>
    </main>
  );
}
