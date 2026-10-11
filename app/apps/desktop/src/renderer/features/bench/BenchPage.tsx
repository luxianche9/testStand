import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider, useEdgesState, useNodesState } from "@xyflow/react";
import type { DeviceInstance, Hardware, ToolCatalogItem } from "@teststand/contracts/devices";
import { PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { openAssistant } from "../../lib/assistant.js";
import { errorMessage } from "../../lib/errors.js";
import { resolvePortRef } from "../../lib/hardware.js";
import { invalidateDeviceData, invalidateWiringData } from "../../lib/mutations.js";
import { useDashboard } from "../../lib/queries.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { onRunRequested } from "../../lib/run-focus.js";
import {
  IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PanelHeader, SegmentedControl, Spinner,
  Splitter, ToolbarDivider, cn, useConfirm, useToast
} from "../../ui/index.js";
import { AddDeviceDialog, pickDevicePackage, type StagedPackage } from "../devices/AddDeviceDialog.js";
import { importBundleFile } from "../devices/BundleActions.js";
import { DeviceEditor } from "../devices/editors/DeviceEditor.js";
import { HardwareEditor } from "../devices/editors/HardwareEditor.js";
import { MonitorPane } from "../monitor/MonitorPane.js";
import { useBenchRun } from "../monitor/use-bench-run.js";
import { streamKey, useMonitorChannels } from "../monitor/use-monitor-channels.js";
import { RunHistory } from "../testing/RunHistory.js";
import { TestPanel } from "../testing/TestPanel.js";
import { EditPinsModal, ListCreateConnectionModal } from "../wiring/ConnectionEditor.js";
import { PinList } from "../wiring/PinList.js";
import {
  NodeContextMenu, WiringCanvas, useTransientNodeUi, type ManualPair, type NodeMenu
} from "../wiring/WiringCanvas.js";
import { ConnectionInspector } from "../wiring/WiringInspector.js";
import { WiringLogPanel } from "../wiring/WiringLogPanel.js";
import { fallbackHardware, toFlowEdges, toFlowNode } from "../wiring/flow-elements.js";
import { useWiringDocument } from "../wiring/use-wiring-document.js";
import {
  sortedPair, straightThrough, touchesHardware, type HardwareFlowNode, type TopologyEdge
} from "../wiring/wiring-model.js";
import { ActionDialog } from "./ActionDialog.js";
import { DeviceControlMenu, type ControlMenuState } from "./DeviceControlMenu.js";
import { DeviceInfoDialog, type InfoTarget } from "./DeviceInfoDialog.js";
import { DeviceList } from "./DeviceList.js";
import { actionName, deviceActions } from "./device-actions.js";
import { SIDE_PANEL_LABELS, type SidePanel } from "../../lib/side-panel.js";

const BANNER = "absolute top-2 right-3 left-3 z-20 shadow-overlay";
export type BenchView = "monitor" | "wiring";
/** 工位接线 shows the same cables two ways: as a pin table, or as a canvas of faceplates. */
type WiringView = "pins" | "ports";

const viewOptions = [
  { value: "monitor", label: "运行监控", title: "设备数据流的示波器和控制台，运行时附带事件时间轴" },
  { value: "wiring", label: "工位接线", title: "实物接线：针脚清单和端口连线图" }
] as const;

const wiringViewOptions = [
  { value: "pins", label: "针脚列表", title: "按端口列出所有接线，含同端口跳线" },
  { value: "ports", label: "端口连线", title: "在画布上摆放设备并拖线" }
] as const;

/**
 * Handed to the assistant's composer unsent: a brief pointing the agent at the bundled plugin guide
 * and the devkit tools (design doc 8.5), with the blanks the operator fills in. The agent reads the
 * manuals itself with import_document, so the brief asks where they are rather than for an upload.
 */
const NEW_ADAPTER_DRAFT = [
  "按设备插件开发指南（read_reference ts-device-plugin）的流程，在本项目里给我写一个新的设备适配器。",
  "",
  "设备型号 / 厂商：",
  "资料位置（手册、头文件、DLL 所在的文件夹）：",
  "它在这台电脑上的样子（设备管理器里的名称、COM 口号、卡号）：",
  "要用到的动作和要看的数据流：",
  "",
  "用 import_document 读手册，devkit 工具生成、检查、打包，devices_addDeviceFromFile 添加；",
  "手册里没有的事实（引脚、量程、安全值、上电状态）不要编，写成 TODO(new_device) 并问我。",
  "在真实硬件上只做只读操作，会改变输出的动作先问我。"
].join("\n");

/**
 * 测试台架, the project's one screen: the sidebar panel the activity bar picks (设备管理, 接线日志,
 * 测试编排, 运行历史) beside 运行监控, which watches device streams and runs, or 工位接线, the
 * physical wiring as a pin list or a port canvas. The two never refer to each other. One title row
 * above them holds the view switch and the shown view's tools.
 */
export function BenchPage({ panel, view, onView }: {
  panel?: SidePanel | undefined;
  view?: BenchView;
  onView?: (view: BenchView) => void;
}) {
  const [own, setOwn] = useState<BenchView>("monitor");
  // A run asked for is shown on 运行监控.
  useEffect(() => onRunRequested(() => (onView ?? setOwn)("monitor")), [onView]);
  return (
    <ReactFlowProvider>
      <Bench panel={panel} view={view ?? own} onView={onView ?? setOwn} />
    </ReactFlowProvider>
  );
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

function Bench({ panel, view, onView }: {
  panel: SidePanel | undefined;
  view: BenchView;
  onView: (view: BenchView) => void;
}) {
  const client = useQueryClient();
  const dashboard = useDashboard();
  const toast = useToast();
  const { project, catalog, save, wiring, hardware, edits } = useWiringDocument();
  const bench = useBenchRun();
  const monitor = useMonitorChannels(undefined);
  const library = useResizableWidth({
    storageKey: "teststand.bench-devices-width", defaultWidth: 300, min: 220, max: 520, direction: "right"
  });
  const sidebar = useResizableWidth({
    storageKey: "teststand.wiring-inspector-width", defaultWidth: 300, min: 240, max: 520, direction: "left"
  });
  const [listCreateOpen, setListCreateOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string>();
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [nodeMenu, setNodeMenu] = useState<NodeMenu>();
  const [editingPortHardwareId, setEditingPortHardwareId] = useState<string>();
  const [controlMenu, setControlMenu] = useState<ControlMenuState>();
  const [action, setAction] = useState<{ tool: ToolCatalogItem; hardwareId: string }>();
  const [info, setInfo] = useState<InfoTarget>();
  const [editingDevice, setEditingDevice] = useState<DeviceInstance>();
  const [staged, setStaged] = useState<StagedPackage>();
  const [pickError, setPickError] = useState<string>();
  const [partEditor, setPartEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const [checking, setChecking] = useState(false);
  const [wiringView, setWiringView] = useState<WiringView>("pins");
  const [confirmRemove, confirmDialog] = useConfirm();
  const [nodes, setNodes, onNodesChange] = useNodesState<HardwareFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyEdge>([]);
  // Each view renders its tools into its own slot of the title row.
  const [monitorTools, setMonitorTools] = useState<HTMLElement | null>(null);
  const [pinTools, setPinTools] = useState<HTMLElement | null>(null);

  const connections = useMemo(() => wiring?.connections ?? [], [wiring?.connections]);
  const online = useMemo(() => new Map((dashboard.data?.availability ?? [])
    .map((item) => [item.hardwareId, item.state === "available"])), [dashboard.data]);
  const shown = useMemo(() => new Set(monitor.channels.map(streamKey)), [monitor.channels]);
  const placed = useMemo(() => new Set((wiring?.nodes ?? []).map((node) => node.hardwareId)), [wiring?.nodes]);

  const { movePort, resizeNode } = edits;
  const flowNodes = useMemo(() => (wiring?.nodes ?? []).map((node) => toFlowNode(
    node,
    hardware.find((entry) => entry.hardwareId === node.hardwareId),
    fallbackHardware(node.hardwareId),
    { editingHardwareId: editingPortHardwareId, movePort, resizeNode }
  )), [editingPortHardwareId, hardware, movePort, resizeNode, wiring?.nodes]);
  const flowEdges = useMemo(
    () => toFlowEdges(connections, hardware).map((edge) => ({ ...edge, selected: edge.id === selectedConnectionId })),
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
  /** A device is added from its device package: pick the .tsdev, then confirm in the dialog. */
  const addDevice = async () => {
    setPickError(undefined);
    try {
      const picked = await pickDevicePackage();
      if (picked) setStaged(picked);
    } catch (error) {
      setPickError(errorMessage(error));
    }
  };
  /** A passive part arrives as a finished `.tshw`: pick it and import, no editor in between. */
  const importPart = async () => {
    setPickError(undefined);
    try {
      const message = await importBundleFile("hardware");
      if (!message) return;
      await refreshAll();
      toast.success(message);
    } catch (error) {
      setPickError(errorMessage(error));
    }
  };
  const devices = dashboard.data?.devices;
  /** A canvas drag between two connectors is the same cable the 针脚列表 creates: confirm it
   *  straight through, then open its pin editor so the mapping can be corrected. */
  const connectOnCanvas = ({ portA, portB }: ManualPair) => {
    const pair = sortedPair(portA, portB);
    const existing = connections.find((item) => sortedPair(item.portA, item.portB) === pair);
    if (existing) { setSelectedConnectionId(existing.connectionId); return; }
    const a = resolvePortRef(portA, hardware);
    const b = resolvePortRef(portB, hardware);
    const connectionId = edits.createConnection(portA, portB, straightThrough(a.port, b.port));
    if (connectionId) { setSelectedConnectionId(connectionId); setEditingConnectionId(connectionId); }
  };
  const removeNode = async (hardwareId: string) => {
    setEditingPortHardwareId((current) => current === hardwareId ? undefined : current);
    const cables = connections.filter((entry) => touchesHardware(entry, hardwareId)).length;
    if (cables > 0 && !await confirmRemove({
      title: "从画布移除",
      message: `这台硬件上还有 ${cables} 条接线，移除卡片会一并删掉它们。`,
      confirmLabel: "移除并删除接线",
      danger: true
    })) return;
    edits.removeNode(hardwareId);
  };
  const openInfo = useCallback((hardwareId: string) => {
    const item = hardware.find((entry) => entry.hardwareId === hardwareId);
    if (item) setInfo({ hardware: item, instance: devices?.find((entry) => entry.hardwareId === hardwareId) });
  }, [devices, hardware]);
  const openControl = useCallback((hardwareId: string, anchor: DOMRect) => {
    setNodeMenu(undefined);
    setControlMenu({ hardwareId, x: anchor.left, y: anchor.bottom + 4 });
  }, []);
  const closeControl = useCallback(() => setControlMenu(undefined), []);
  const actionsOf = (hardwareId: string) => deviceActions(
    dashboard.data?.tools ?? [],
    devices?.find((item) => item.hardwareId === hardwareId)?.deviceId
  );

  if (project.isError) {
    return <Centered><ErrorBanner className="max-w-[560px]" message={errorMessage(project.error)} /></Centered>;
  }
  if (project.isLoading || catalog.isLoading || !wiring) {
    return <Centered><Spinner label="正在加载测试台架" /></Centered>;
  }

  const editingConnection = connections.find((item) => item.connectionId === editingConnectionId);
  const selectedConnection = connections.find((item) => item.connectionId === selectedConnectionId);
  const inspecting = view === "wiring" && wiringView === "ports" && selectedConnection;
  const controlled = controlMenu && hardware.find((item) => item.hardwareId === controlMenu.hardwareId);
  const actionHardware = action && hardware.find((item) => item.hardwareId === action.hardwareId);
  const devicesHeader = (
    <PanelHeader
      title={SIDE_PANEL_LABELS.devices}
      meta={hardware.length}
      actions={(
        <>
          <IconButton label="检测设备状态" size="icon-sm" disabled={checking} onClick={() => void checkStatus()}>
            <RefreshCwIcon className={cn(checking && "animate-spin")} />
          </IconButton>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="添加" size="icon-sm"><PlusIcon /></IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void addDevice()}>添加设备…</MenuItem>
              <MenuItem onSelect={() => setPartEditor({ open: true })}>添加被测件 / 夹具</MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => void importPart()}>导入被测件 / 夹具（.tshw）…</MenuItem>
              <MenuItem onSelect={() => openAssistant(NEW_ADAPTER_DRAFT)}>让 Agent 照着手册写新适配器</MenuItem>
            </MenuContent>
          </Menu>
        </>
      )}
    />
  );
  // `hidden` comes last: merged after a display class such as `flex`, it would lose.
  const panelClass = (side: SidePanel, className?: string) =>
    cn("min-h-0 min-w-0", className, panel !== side && "hidden");

  return (
    <main className="h-full min-h-0 min-w-0 overflow-hidden bg-surface-0">
      <section
        className="grid h-full"
        style={{
          gridTemplateColumns: (panel ? `${library.width}px 1px ` : "") + "minmax(0, 1fr)"
            + (inspecting ? ` 1px ${sidebar.width}px` : "")
        }}
      >
        {/* Every panel stays mounted: the test panel keeps the open plan's draft while another is shown. */}
        <div id="bench-side-devices" className={panelClass("devices")}>
          <DeviceList
            header={devicesHeader}
            hardware={hardware}
            shown={shown}
            placed={placed}
            onOpen={(item) => openInfo(item.hardwareId)}
            onControl={openControl}
            onAddStream={(ref) => { monitor.add(ref); onView("monitor"); }}
            footer={hardware.length > 0 && (
              <p className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-fg-3">
                展开设备，把数据流拖到运行监控；把设备拖到端口连线画布上放置
              </p>
            )}
          />
        </div>
        <div id="bench-side-log" className={panelClass("log")}><WiringLogPanel hardware={hardware} /></div>
        <div id="bench-side-testing" className={panelClass("testing")}><TestPanel bench={bench} /></div>
        <section id="bench-side-history" aria-label={SIDE_PANEL_LABELS.history}
          className={panelClass("history", "flex flex-col bg-surface-1")}>
          <PanelHeader title={SIDE_PANEL_LABELS.history} />
          <RunHistory
            selectedRunId={bench.runId}
            onOpenRun={(runId) => { bench.setRunId(runId); onView("monitor"); }}
          />
        </section>
        {panel && <Splitter label="调整侧栏宽度" {...library.separatorProps} />}
        <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <div role="toolbar" aria-label="台架工具栏"
            className="flex h-9 min-w-0 items-center gap-1.5 border-b border-line bg-surface-1 px-2">
            <SegmentedControl<BenchView> label="台架视图" value={view} options={viewOptions} onChange={onView} />
            {save.isPending && <span className="text-2xs whitespace-nowrap text-fg-3">正在保存…</span>}
            <ToolbarDivider />
            <div ref={setMonitorTools} role="group" aria-label="运行监控工具"
              className={cn("flex min-w-0 flex-1 items-center gap-1", view !== "monitor" && "hidden")} />
            <div role="group" aria-label="工位接线工具"
              className={cn("flex min-w-0 flex-1 items-center gap-1.5", view !== "wiring" && "hidden")}>
              <SegmentedControl<WiringView>
                label="接线视图" size="xs" value={wiringView} options={wiringViewOptions} onChange={setWiringView}
              />
              {/* One sub-slot per wiring view, both kept mounted so the portal target never moves. */}
              <span ref={setPinTools} role="group" aria-label="针脚列表工具"
                className={cn("flex min-w-0 flex-1 items-center gap-1.5", wiringView !== "pins" && "hidden")} />
              <span role="group" aria-label="端口连线工具"
                className={cn("flex min-w-0 flex-1 items-center gap-1.5", wiringView !== "ports" && "hidden")}>
                <span className="tf-label text-fg-3">画布设备</span>
                <span className="tf-num text-xs text-fg">{wiring.nodes.length}</span>
                <span className="tf-label ml-2 text-fg-3">接线</span>
                <span className="tf-num text-xs text-fg">{connections.length}</span>
                <span className="ml-auto text-2xs whitespace-nowrap text-fg-3">
                  从左侧拖设备上画布，再从端口拖线
                </span>
              </span>
            </div>
          </div>
          <div className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)]">
            {pickError && <ErrorBanner className={BANNER} message={pickError} />}
            {save.isError && (
              <ErrorBanner className={BANNER} message={errorMessage(save.error)} />
            )}
            {/* All three stay mounted: 运行监控 keeps its live data, the canvas keeps its viewport. */}
            <div className={cn("min-h-0", view !== "monitor" && "hidden")}>
              <MonitorPane bench={bench} toolbar={monitorTools} />
            </div>
            <div className={cn("min-h-0", !(view === "wiring" && wiringView === "pins") && "hidden")}>
              <PinList
                connections={connections}
                hardware={hardware}
                busy={save.isPending}
                toolbar={pinTools}
                onCreate={() => setListCreateOpen(true)}
                onEdit={setEditingConnectionId}
                onRemove={edits.removeConnection}
              />
            </div>
            <div className={cn("min-h-0", !(view === "wiring" && wiringView === "ports") && "hidden")}>
              <WiringCanvas
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={connectOnCanvas}
                onDropHardware={edits.addNode}
                onMoveNode={edits.moveNode}
                onSelectConnection={setSelectedConnectionId}
                onNodeMenu={(menu) => { setControlMenu(undefined); setNodeMenu(menu); }}
              />
            </div>
          </div>
        </section>
        {inspecting && <>
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
          onRemove={() => { setNodeMenu(undefined); void removeNode(nodeMenu.hardwareId); }}
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
        available={action ? online.get(action.hardwareId) === true : false}
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
          if (target.instance) setEditingDevice(target.instance);
          else setPartEditor({ open: true, hardware: target.hardware });
        }}
        onChanged={refreshAll}
      />
      <DeviceEditor instance={editingDevice} onClose={() => setEditingDevice(undefined)} onChanged={refreshAll} />
      <HardwareEditor
        open={partEditor.open}
        hardware={partEditor.hardware}
        onClose={() => setPartEditor({ open: false })}
        onChanged={refreshAll}
      />
      <AddDeviceDialog staged={staged} onClose={() => setStaged(undefined)} onAdded={refreshAll} />
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
      {confirmDialog}
    </main>
  );
}
