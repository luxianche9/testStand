import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeviceInstance, Hardware, ToolCatalogItem } from "@teststand/contracts/devices";
import { PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { invalidateDeviceData, invalidateWiringData } from "../../lib/mutations.js";
import { useDashboard, useProjectDocument } from "../../lib/queries.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { onRunRequested } from "../../lib/run-focus.js";
import {
  IconButton, Menu, MenuContent, MenuItem, MenuTrigger, PanelHeader, SegmentedControl, Spinner, Splitter, cn
} from "../../ui/index.js";
import { AddDeviceDialog, pickDevicePackage, type StagedPackage } from "../devices/AddDeviceDialog.js";
import { DeviceEditor } from "../devices/editors/DeviceEditor.js";
import { HardwareEditor } from "../devices/editors/HardwareEditor.js";
import { SignalViewPane } from "../signals/SignalViewPane.js";
import { useBenchRun } from "../signals/use-bench-run.js";
import { WidgetPalette } from "../signals/WidgetPalette.js";
import { RunHistory } from "../testing/RunHistory.js";
import { TestPanel } from "../testing/TestPanel.js";
import { EditPinsModal, ListCreateConnectionModal } from "../wiring/ConnectionEditor.js";
import { PinList } from "../wiring/PinList.js";
import { WiringLogPanel } from "../wiring/WiringLogPanel.js";
import { useWiringDocument } from "../wiring/use-wiring-document.js";
import { ActionDialog } from "./ActionDialog.js";
import { DeviceControlMenu, type ControlMenuState } from "./DeviceControlMenu.js";
import { DeviceInfoDialog, type InfoTarget } from "./DeviceInfoDialog.js";
import { DeviceList } from "./DeviceList.js";
import { actionName, deviceActions } from "./device-actions.js";
import { SIDE_PANEL_LABELS, type SidePanel } from "../../lib/side-panel.js";

const BANNER = "absolute top-2 right-3 left-3 z-20 shadow-overlay";
export type BenchView = "signals" | "pins";

const viewOptions = [
  { value: "signals", label: "信号视图", title: "逻辑信号、它们之间的连接，以及显示和控制控件" },
  { value: "pins", label: "针脚列表", title: "实物接线：哪些针脚连在一起" }
] as const;

/**
 * 测试台架, the project's one screen: the sidebar panel the activity bar picks (设备 and 控件, 测试,
 * 运行记录, 接线日志) beside the signal view, where signals feed displays and controls drive signals,
 * or the physical wiring as a pin list. The physical and the logical view never refer to each other.
 */
export function BenchPage({ panel, view, onView }: {
  panel?: SidePanel | undefined;
  view?: BenchView;
  onView?: (view: BenchView) => void;
}) {
  const [own, setOwn] = useState<BenchView>("signals");
  // A run asked for is shown on the signal view.
  useEffect(() => onRunRequested(() => (onView ?? setOwn)("signals")), [onView]);
  return <Bench panel={panel} view={view ?? own} onView={onView ?? setOwn} />;
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
  const document = useProjectDocument();
  const { project, catalog, save, wiring, hardware, edits } = useWiringDocument();
  const bench = useBenchRun();
  const library = useResizableWidth({
    storageKey: "teststand.bench-devices-width", defaultWidth: 300, min: 220, max: 520, direction: "right"
  });
  const [listCreateOpen, setListCreateOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string>();
  const [controlMenu, setControlMenu] = useState<ControlMenuState>();
  const [action, setAction] = useState<{ tool: ToolCatalogItem; hardwareId: string }>();
  const [info, setInfo] = useState<InfoTarget>();
  const [editingDevice, setEditingDevice] = useState<DeviceInstance>();
  const [staged, setStaged] = useState<StagedPackage>();
  const [pickError, setPickError] = useState<string>();
  const [partEditor, setPartEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const [checking, setChecking] = useState(false);

  const connections = useMemo(() => wiring?.connections ?? [], [wiring?.connections]);
  const online = useMemo(() => new Map((dashboard.data?.availability ?? [])
    .map((item) => [item.hardwareId, item.state === "available"])), [dashboard.data]);
  const placed = useMemo(() => new Set((document.data?.file.signals.nodes ?? [])
    .flatMap((node) => node.kind === "hardware" ? [node.hardwareId] : [])), [document.data]);

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
  const devices = dashboard.data?.devices;
  const openInfo = useCallback((hardwareId: string) => {
    const item = hardware.find((entry) => entry.hardwareId === hardwareId);
    if (item) setInfo({ hardware: item, instance: devices?.find((entry) => entry.hardwareId === hardwareId) });
  }, [devices, hardware]);
  const openControl = useCallback((hardwareId: string, anchor: DOMRect) => {
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
            </MenuContent>
          </Menu>
        </>
      )}
    />
  );
  // `hidden` comes last: merged after a display class such as `flex`, it would lose.
  const shown = (side: SidePanel, className?: string) => cn("min-h-0 min-w-0", className, panel !== side && "hidden");

  return (
    <main className="h-full min-h-0 min-w-0 overflow-hidden bg-surface-0">
      <section
        className="grid h-full"
        style={{ gridTemplateColumns: panel ? `${library.width}px 1px minmax(0, 1fr)` : "minmax(0, 1fr)" }}
      >
        {/* Every panel stays mounted: the test panel keeps the open plan's draft while another is shown. */}
        <div id="bench-side-devices" className={shown("devices")}>
          <DeviceList
            header={devicesHeader}
            hardware={hardware}
            placed={placed}
            onOpen={(item) => openInfo(item.hardwareId)}
            footer={(
              <>
                {hardware.length > 0 && (
                  <p className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-fg-3">
                    单击查看信息，拖到信号视图上放置
                  </p>
                )}
                <WidgetPalette onPlace={() => onView("signals")} />
              </>
            )}
          />
        </div>
        <div id="bench-side-testing" className={shown("testing")}><TestPanel bench={bench} /></div>
        <section id="bench-side-history" aria-label={SIDE_PANEL_LABELS.history}
          className={shown("history", "flex flex-col bg-surface-1")}>
          <PanelHeader title={SIDE_PANEL_LABELS.history} />
          <RunHistory
            selectedRunId={bench.runId}
            onOpenRun={(runId) => { bench.setRunId(runId); onView("signals"); }}
          />
        </section>
        <div id="bench-side-log" className={shown("log")}><WiringLogPanel hardware={hardware} /></div>
        {panel && <Splitter label="调整侧栏宽度" {...library.separatorProps} />}
        <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <div className="flex h-9 items-center gap-2 border-b border-line bg-surface-1 px-2">
            <SegmentedControl<BenchView> label="台架视图" value={view} options={viewOptions} onChange={onView} />
            {save.isPending && <span className="text-2xs text-fg-3">正在保存…</span>}
          </div>
          <div className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)]">
            {pickError && <ErrorBanner className={BANNER} message={pickError} />}
            {save.isError && (
              <ErrorBanner className={BANNER} message={errorMessage(save.error)} />
            )}
            {/* Both stay mounted: the signal view keeps its live data while the pin list is shown. */}
            <div className={cn("min-h-0", view !== "signals" && "hidden")}>
              <SignalViewPane bench={bench} online={online} onInfo={openInfo} onControl={openControl} />
            </div>
            <div className={cn("min-h-0", view !== "pins" && "hidden")}>
              <PinList
                connections={connections}
                hardware={hardware}
                busy={save.isPending}
                onCreate={() => setListCreateOpen(true)}
                onEdit={setEditingConnectionId}
                onRemove={edits.removeConnection}
              />
            </div>
          </div>
        </section>
      </section>

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
    </main>
  );
}
