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
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { PinPair, PortPosition, PortSide, ProjectWiring } from "@hardwareharness/contracts/wiring";
import { errorMessage } from "../../shared/errors.js";
import { CableIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "../../shared/ui/cn";
import { Button } from "../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../shared/ui/dialog";
import { Spinner } from "../../shared/ui/skeleton";
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
  const project = useQuery({ queryKey: queryKeys.projectDocument, queryFn: () => window.hardwareharness.projects.current() });
  const catalog = useDeviceCatalog();
  // wiringTask/project 事件的订阅在 AppShell 全局进行，这里只读共享缓存。
  const tasks = useWiringTasks();

  const save = useMutation({
    mutationFn: (next: ProjectWiring) => window.hardwareharness.wiring.update(next),
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
      [assetKey(hardwareId, assetId), await window.hardwareharness.devices.hardwareImageUrl(hardwareId, assetId)] as const))
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
    const hardwareId = event.dataTransfer.getData("application/hardwareharness-hardware");
    if (!hardwareId) return;
    addNode(hardwareId, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [addNode, flow]);

  const refreshAll = useCallback(async () => invalidateWiringData(client), [client]);

  if (wiringDoc.isLoading || catalog.isLoading || !wiring) return <main className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden bg-background"><Spinner label="正在加载接线画布" /></main>;
  if (wiringDoc.isError) return <main className="grid h-full min-h-0 min-w-0 place-items-center overflow-hidden bg-background"><div className="flex max-w-[560px] items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none"><TriangleAlertIcon className="size-4" />{errorMessage(wiringDoc.error)}</div></main>;

  const selectedConnection = connections.find((item) => item.connectionId === selectedConnectionId);
  const editingConnection = connections.find((item) => item.connectionId === editingConnectionId);
  const activeTask = taskList.find((task) => task.status === "in_progress") ?? taskList.find((task) => task.status === "pending");

  return (
    <main className="h-full min-h-0 min-w-0 overflow-hidden bg-background">
      <section className="grid h-full" style={{ gridTemplateColumns: `${library.width}px 4px minmax(0, 1fr)` }}>
        <HardwareLibrary
          hardware={hardware}
          assetUrls={assetUrls}
          placed={new Set(wiring.nodes.map((node) => node.hardwareId))}
          onAdd={addNode}
          onRefresh={() => void refreshAll()}
        />
        <div className="w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ring/30" role="separator" aria-orientation="vertical" aria-label="调整硬件库宽度" title="拖拽调整宽度" {...library.handleProps} />
        <section className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
          {save.isError && <div className="absolute top-2.5 right-3 left-3 z-20 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-popover px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive shadow-md [&_svg]:mt-0.5 [&_svg]:flex-none"><TriangleAlertIcon className="size-4" />{errorMessage(save.error)}</div>}
          <div className={cn("relative flex h-full min-h-0 flex-col", view === "list" && "bg-secondary/40")} onDrop={view === "canvas" ? onDrop : undefined} onDragOver={view === "canvas" ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } : undefined}>
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
                  <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--tf-canvas-grid)" bgColor="var(--tf-canvas)" />
                  <Controls position="bottom-right" showInteractive={false} />
                  {!nodes.length && <div className="pointer-events-none absolute inset-0 z-[1] grid place-content-center justify-items-center gap-2 text-center text-muted-foreground"><CableIcon className="size-7" /><strong className="text-sm text-foreground">从左侧硬件库拖入设备</strong><span className="max-w-[300px] text-xs">画布是工程文档，加入节点不会调用远端硬件。</span></div>}
                </ReactFlow>
                {selectedConnection && <ConnectionDrawer connection={selectedConnection} hardware={hardware} onClose={() => setSelectedConnectionId(undefined)} onEdit={() => setEditingConnectionId(selectedConnection.connectionId)} onRemove={removeConnection} removing={save.isPending} />}
                {nodeMenu && (() => {
                  const menuNode = wiring.nodes.find((item) => item.hardwareId === nodeMenu.hardwareId);
                  const showingImage = menuNode?.showImage !== false;
                  const itemClass = "flex min-h-8 w-full items-center rounded-sm px-2.5 text-left text-xs whitespace-nowrap transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none active:translate-y-px disabled:pointer-events-none disabled:opacity-50";
                  return <div
                    className="wiring-node-menu fixed z-30 grid w-[168px] gap-0.5 rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-border animate-fade-in"
                    role="menu"
                    aria-label="硬件操作"
                    style={{ left: nodeMenu.x, top: nodeMenu.y }}
                  >
                    <button type="button" role="menuitem" className={itemClass} onClick={() => { setEditingPortHardwareId(nodeMenu.hardwareId); setNodeMenu(undefined); }}>改变端口位置</button>
                    <button type="button" role="menuitem" className={itemClass} onClick={() => {
                      const hardwareId = nodeMenu.hardwareId;
                      setNodeMenu(undefined);
                      toggleNodeImage(hardwareId);
                    }}>{showingImage ? "隐藏图片" : "显示图片"}</button>
                    <button type="button" role="menuitem" className={cn(itemClass, "text-destructive hover:bg-destructive/10 hover:text-destructive")} onClick={() => {
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
      <Dialog open={Boolean(pendingRemoveHardwareId)} onOpenChange={(open) => { if (!open) setPendingRemoveHardwareId(undefined); }}>
        <DialogContent size="sm">
          <DialogHeader title="移除画布节点" onClose={() => setPendingRemoveHardwareId(undefined)} />
          <DialogBody>
            <p className="m-0 text-sm">{hardware.find((item) => item.hardwareId === pendingRemoveHardwareId)?.label ?? pendingRemoveHardwareId} 上还有已确认的接线。移除画布节点会同时删除这些接线记录。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRemoveHardwareId(undefined)}>取消</Button>
            <Button variant="destructive" onClick={() => { if (pendingRemoveHardwareId) commitRemoveNode(pendingRemoveHardwareId); }}>移除并删除接线</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
