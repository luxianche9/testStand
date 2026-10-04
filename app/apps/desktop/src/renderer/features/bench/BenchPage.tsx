import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider, useEdgesState, useNodesState } from "@xyflow/react";
import type { DeviceInstance, Hardware, ToolCatalogItem } from "@teststand/contracts/devices";
import { BoxesIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { invalidateDeviceData, invalidateWiringData } from "../../lib/mutations.js";
import { useDashboard, useWiringTasks } from "../../lib/queries.js";
import { useResizableWidth } from "../../lib/resizable.js";
import {
  Button, ConfirmDialog, HeaderTabs, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, SegmentedControl, Spinner,
  Splitter, Toolbar, ToolbarDivider, cn
} from "../../ui/index.js";
import { DevicePackagesDialog } from "../devices/DevicePackages.js";
import { DeviceEditor } from "../devices/editors/DeviceEditor.js";
import { HardwareEditor } from "../devices/editors/HardwareEditor.js";
import { EditPinsModal, ListCreateConnectionModal, ManualConnectionModal } from "../wiring/ConnectionEditor.js";
import { NodeContextMenu, WiringCanvas, useTransientNodeUi } from "../wiring/WiringCanvas.js";
import { ConnectionInspector, WiringList } from "../wiring/WiringInspector.js";
import { WiringLogPanel } from "../wiring/WiringLogPanel.js";
import { fallbackHardware, toFlowEdges, toFlowNode } from "../wiring/flow-elements.js";
import { useWiringDocument } from "../wiring/use-wiring-document.js";
import {
  isTaskActionable, touchesHardware, type HardwareFlowNode, type ManualPair, type NodeMenu, type TopologyEdge
} from "../wiring/wiring-model.js";
import { ActionDialog } from "./ActionDialog.js";
import { DeviceControlMenu, type ControlMenuState } from "./DeviceControlMenu.js";
import { DeviceInfoDialog, type InfoTarget } from "./DeviceInfoDialog.js";
import { DeviceList } from "./DeviceList.js";
import { actionName, deviceActions } from "./device-actions.js";

type SideTab = "devices" | "log";
type CanvasView = "canvas" | "list";

const viewOptions = [
  { value: "canvas", label: "画布", title: "在画布上摆放设备并拖线" },
  // Same-port jumpers cannot be drawn on the canvas; the list shows every cable.
  { value: "list", label: "列表", title: "按端口列出所有接线" }
] as const;

/** 测试台架: the devices of this bench, the canvas they are wired on, and their controls. */
export function BenchPage() {
  return <ReactFlowProvider><Bench /></ReactFlowProvider>;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="grid h-full min-h-0 min-w-0 place-items-center overflow-hidden bg-surface-0">{children}</main>
  );
}

function ErrorBanner({ message, className }: { message: string; className?: string }) {
  return (
    <div role="alert" className={cn(
      "flex items-start gap-2 rounded-md border border-fail/35 bg-fail/8 px-3 py-2 text-xs text-fail", className
    )}>
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="break-words whitespace-pre-wrap">{message}</span>
    </div>
  );
}

/** Layout changes are saved automatically; structural edits remain in the project buffer. */
function Bench() {
  const client = useQueryClient();
  const dashboard = useDashboard();
  const { project, catalog, save, wiring, hardware, edits } = useWiringDocument();
  const [sideTab, setSideTab] = useState<SideTab>("devices");
  const [view, setView] = useState<CanvasView>("canvas");
  const tasks = useWiringTasks();
  const library = useResizableWidth({
    storageKey: "teststand.bench-devices-width", defaultWidth: 300, min: 220, max: 520, direction: "right"
  });
  const sidebar = useResizableWidth({
    storageKey: "teststand.wiring-inspector-width", defaultWidth: 300, min: 240, max: 520, direction: "left"
  });
  const [manualPair, setManualPair] = useState<ManualPair>();
  const [listCreateOpen, setListCreateOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string>();
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [nodeMenu, setNodeMenu] = useState<NodeMenu>();
  const [pendingRemoveHardwareId, setPendingRemoveHardwareId] = useState<string>();
  const [editingPortHardwareId, setEditingPortHardwareId] = useState<string>();
  const [controlMenu, setControlMenu] = useState<ControlMenuState>();
  const [action, setAction] = useState<{ tool: ToolCatalogItem; hardwareId: string }>();
  const [info, setInfo] = useState<InfoTarget>();
  const [deviceEditor, setDeviceEditor] = useState<{ open: boolean; instance?: DeviceInstance }>({ open: false });
  const [partEditor, setPartEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const [typesOpen, setTypesOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<HardwareFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyEdge>([]);

  const connections = useMemo(() => wiring?.connections ?? [], [wiring?.connections]);
  const { movePort, resizeNode } = edits;
  const openControl = useCallback((hardwareId: string, anchor: DOMRect) => {
    setNodeMenu(undefined);
    setControlMenu({ hardwareId, x: anchor.left, y: anchor.bottom + 4 });
  }, []);

  const flowNodes = useMemo(() => (wiring?.nodes ?? []).map((node) => toFlowNode(
    node,
    hardware.find((entry) => entry.hardwareId === node.hardwareId),
    fallbackHardware(node.hardwareId),
    { interactive: true, editingHardwareId: editingPortHardwareId, movePort, resizeNode, onControl: openControl }
  )), [editingPortHardwareId, hardware, movePort, openControl, resizeNode, wiring?.nodes]);
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

  const closeMenu = useCallback(() => setNodeMenu(undefined), []);
  const closeControl = useCallback(() => setControlMenu(undefined), []);
  const stopEditing = useCallback(() => setEditingPortHardwareId(undefined), []);
  useTransientNodeUi({ menu: nodeMenu, editingHardwareId: editingPortHardwareId, closeMenu, stopEditing });

  const refreshAll = async () => {
    await Promise.all([invalidateDeviceData(client), invalidateWiringData(client)]);
  };
  const checkStatus = async () => {
    setChecking(true);
    try {
      await Promise.allSettled((dashboard.data?.devices ?? [])
        .map(({ deviceId }) => window.teststand.devices.refreshDevice({ deviceId })));
    } finally {
      await refreshAll();
      setChecking(false);
    }
  };
  const requestRemoveNode = (hardwareId: string) => {
    setEditingPortHardwareId((current) => current === hardwareId ? undefined : current);
    if (connections.some((entry) => touchesHardware(entry, hardwareId))) setPendingRemoveHardwareId(hardwareId);
    else edits.removeNode(hardwareId);
  };
  const instanceOf = (item: Hardware) => dashboard.data?.devices.find((entry) => entry.hardwareId === item.hardwareId);
  const openInfo = (item: Hardware) => setInfo({ hardware: item, instance: instanceOf(item) });
  const actionsOf = (hardwareId: string) => deviceActions(
    dashboard.data?.tools ?? [],
    dashboard.data?.devices.find((item) => item.hardwareId === hardwareId)?.deviceId
  );
  const isAvailable = (hardwareId: string) =>
    dashboard.data?.availability?.find((item) => item.hardwareId === hardwareId)?.state === "available";

  if (project.isError) {
    return <Centered><ErrorBanner className="max-w-[560px]" message={errorMessage(project.error)} /></Centered>;
  }
  if (project.isLoading || catalog.isLoading || !wiring) {
    return <Centered><Spinner label="正在加载测试台架" /></Centered>;
  }

  const selectedConnection = connections.find((item) => item.connectionId === selectedConnectionId);
  const editingConnection = connections.find((item) => item.connectionId === editingConnectionId);
  const pendingLabel = hardware.find((item) => item.hardwareId === pendingRemoveHardwareId)?.label
    ?? pendingRemoveHardwareId;
  const allTasks = tasks.data ?? [];
  const pendingTaskCount = allTasks.filter(isTaskActionable).length;
  const controlled = controlMenu && hardware.find((item) => item.hardwareId === controlMenu.hardwareId);
  const actionHardware = action && hardware.find((item) => item.hardwareId === action.hardwareId);
  const sideTabs = (
    <HeaderTabs<SideTab>
      label="测试台架侧栏"
      idPrefix="bench-side"
      value={sideTab}
      onChange={setSideTab}
      actions={sideTab === "devices" && (
        <span className="ml-auto flex items-center gap-0.5">
          <IconButton label="设备类型" size="icon-sm" onClick={() => setTypesOpen(true)}><BoxesIcon /></IconButton>
          <IconButton label="检测设备状态" size="icon-sm" disabled={checking} onClick={() => void checkStatus()}>
            <RefreshCwIcon className={cn(checking && "animate-spin")} />
          </IconButton>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="添加" size="icon-sm"><PlusIcon /></IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => setDeviceEditor({ open: true })}>添加设备</MenuItem>
              <MenuItem onSelect={() => setPartEditor({ open: true })}>添加被测件 / 夹具</MenuItem>
            </MenuContent>
          </Menu>
        </span>
      )}
      options={[
        { value: "devices", label: "设备", meta: hardware.length },
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
            + (selectedConnection && view === "canvas" ? ` 1px ${sidebar.width}px` : "")
        }}
      >
        {sideTab === "devices" ? (
          <DeviceList
            id="bench-side-devices"
            role="tabpanel"
            header={sideTabs}
            hardware={hardware}
            placed={new Set(wiring.nodes.map((node) => node.hardwareId))}
            onOpen={openInfo}
            footer={hardware.length > 0 && (
              <p className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-fg-3">单击查看信息，拖到画布上放置</p>
            )}
          />
        ) : (
          <WiringLogPanel id="bench-side-log" role="tabpanel" header={sideTabs} hardware={hardware} />
        )}
        <Splitter label="调整侧栏宽度" {...library.separatorProps} />
        <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <Toolbar aria-label="画布工具栏">
            <SegmentedControl<CanvasView> label="接线视图" value={view} options={viewOptions} onChange={setView} />
            <ToolbarDivider />
            <span className="tf-label text-fg-3">设备</span>
            <span className="tf-num text-xs text-fg">{wiring.nodes.length}</span>
            <span className="tf-label ml-2 text-fg-3">接线</span>
            <span className="tf-num text-xs text-fg">{connections.length}</span>
            {save.isPending && <span className="ml-2 text-2xs text-fg-3">正在保存…</span>}
            <Button variant="primary" size="xs" className="ml-auto" onClick={() => setListCreateOpen(true)}>
              <PlusIcon />新建接线
            </Button>
          </Toolbar>
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
                onNodeMenu={(menu) => { setControlMenu(undefined); setNodeMenu(menu); }}
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
        {selectedConnection && view === "canvas" && <>
          <Splitter label="调整接线属性栏宽度" {...sidebar.separatorProps} />
          <ConnectionInspector
            connection={selectedConnection}
            hardware={hardware}
            onClose={() => setSelectedConnectionId(undefined)}
            onEdit={() => setEditingConnectionId(selectedConnection.connectionId)}
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
      {controlMenu && controlled && (
        <DeviceControlMenu
          menu={controlMenu}
          label={controlled.label}
          actions={actionsOf(controlMenu.hardwareId)}
          onPick={(tool) => { setAction({ tool, hardwareId: controlMenu.hardwareId }); setControlMenu(undefined); }}
          onClose={closeControl}
        />
      )}
      <ActionDialog
        action={action?.tool}
        title={action ? actionName(action.tool, actionsOf(action.hardwareId)) : ""}
        deviceLabel={actionHardware?.label ?? ""}
        hardwareId={action?.hardwareId ?? ""}
        available={action ? isAvailable(action.hardwareId) : false}
        onClose={() => setAction(undefined)}
      />
      <DeviceInfoDialog
        target={info && {
          hardware: hardware.find((item) => item.hardwareId === info.hardware.hardwareId) ?? info.hardware,
          instance: info.instance
        }}
        onClose={() => setInfo(undefined)}
        onEdit={(target) => {
          setInfo(undefined);
          if (target.instance) setDeviceEditor({ open: true, instance: target.instance });
          else setPartEditor({ open: true, hardware: target.hardware });
        }}
        onChanged={refreshAll}
      />
      <DeviceEditor
        open={deviceEditor.open}
        instance={deviceEditor.instance}
        onClose={() => setDeviceEditor({ open: false })}
        onChanged={refreshAll}
      />
      <HardwareEditor
        open={partEditor.open}
        hardware={partEditor.hardware}
        onClose={() => setPartEditor({ open: false })}
        onChanged={refreshAll}
      />
      <DevicePackagesDialog open={typesOpen} onClose={() => setTypesOpen(false)} />
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
