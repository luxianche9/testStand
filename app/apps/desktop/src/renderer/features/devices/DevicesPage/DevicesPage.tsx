import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Hardware, DeviceInstance } from "@teststand/contracts/devices";
import { BoxesIcon, CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { errorMessage } from "../../../lib/errors.js";
import { invalidateDeviceData } from "../../../lib/mutations.js";
import { useDashboard, useDeviceCatalog } from "../../../lib/queries.js";
import { useResizableWidth } from "../../../lib/resizable.js";
import { Button, cn, EmptyState, Panel, PanelBody, PanelHeader, Spinner, Splitter } from "../../../ui";
import { DeviceInspector } from "./DeviceInspector.js";
import { DevicePackagesDialog } from "./DevicePackages.js";
import { HardwareListTree } from "./HardwareListTree.js";
import { HardwareEditor } from "./editors/HardwareEditor.js";
import { DeviceEditor } from "./editors/DeviceEditor.js";

export function DevicesPage() {
  const query = useDashboard();
  const catalog = useDeviceCatalog();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [deviceEditor, setDeviceEditor] = useState<{ open: boolean; instance?: DeviceInstance }>({ open: false });
  const [hardwareEditor, setHardwareEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const [typesOpen, setTypesOpen] = useState(false);
  const sidebar = useResizableWidth({
    storageKey: "teststand.devices-sidebar-width",
    defaultWidth: 320,
    min: 240,
    max: 560,
    direction: "right"
  });

  const refreshAll = async () => invalidateDeviceData(client);
  const refreshHardware = useMutation({
    mutationFn: () => window.teststand.devices.listManagedHardware(),
    onSettled: () => void refreshAll()
  });
  const refreshHardwareRef = useRef(refreshHardware.mutate);
  useEffect(() => { refreshHardwareRef.current = refreshHardware.mutate; }, [refreshHardware.mutate]);
  // Re-read hardware descriptors whenever a device comes online (its list_hardware may have changed).
  const mcpOnlineRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const statuses = query.data?.deviceStatuses;
    if (!statuses) return;
    const online = statuses.filter((item) => item.transport.state === "online").map((item) => item.deviceId);
    const becameOnline = online.filter((id) => !mcpOnlineRef.current.has(id));
    mcpOnlineRef.current = new Set(online);
    if (becameOnline.length > 0) refreshHardwareRef.current();
  }, [query.data?.deviceStatuses]);

  const probeStatuses = useMutation({
    mutationFn: async () => {
      const snapshot = query.data;
      if (!snapshot) return;
      await Promise.allSettled(
        snapshot.devices.map(({ deviceId }) => window.teststand.devices.refreshDevice({ deviceId }))
      );
      try {
        await window.teststand.devices.listManagedHardware();
      } catch {
        // Partial outages are reflected in the per-device statuses above.
      }
    },
    onSettled: () => void refreshAll()
  });

  const isOpen = (key: string) => expanded[key] ?? true;
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  const data = query.data;
  const hardware = catalog.data?.hardware ?? [];
  const firstDevice = data?.devices[0];
  const firstPassive = hardware.find((item) => item.kind === "passive");
  const effectiveSelected = selected
    ?? (firstDevice ? `s:${firstDevice.deviceId}` : firstPassive ? `l:${firstPassive.hardwareId}` : null);

  return (
    <div
      className="grid h-full min-h-0 bg-surface-0"
      style={{ gridTemplateColumns: `${sidebar.width}px 1px minmax(0,1fr)` }}
    >
      <Panel as="aside" aria-label="设备树">
        <PanelHeader
          title="设备管理"
          actions={
            <>
              <Button size="xs" variant="ghost" title="已安装的设备类型与设备包" onClick={() => setTypesOpen(true)}>
                <BoxesIcon />设备类型
              </Button>
              <Button
                size="xs"
                variant="ghost"
                title="检测所有设备的连接状态"
                disabled={probeStatuses.isPending || !data}
                onClick={() => probeStatuses.mutate()}
              >
                <RefreshCwIcon className={cn(probeStatuses.isPending && "animate-spin")} />状态检测
              </Button>
            </>
          }
        />
        <PanelBody>
          {data ? (
            <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-1 pb-3">
              <HardwareListTree
                data={data}
                hardware={hardware}
                selected={effectiveSelected}
                isOpen={isOpen}
                onSelect={setSelected}
                onToggle={toggle}
                onAddDevice={() => setDeviceEditor({ open: true })}
                onAddHardware={() => setHardwareEditor({ open: true })}
              />
            </div>
          ) : query.isError ? (
            <EmptyState
              compact
              icon={<CircleAlertIcon />}
              title="无法加载数据"
              description={errorMessage(query.error)}
              action={<Button size="xs" onClick={() => void query.refetch()}>重试</Button>}
            />
          ) : (
            <div className="grid h-24 place-items-center text-fg-3"><Spinner label="正在加载…" /></div>
          )}
        </PanelBody>
      </Panel>
      <Splitter label="拖拽调整面板宽度" {...sidebar.separatorProps} />
      <Panel as="section" aria-label="设备详情">
        {data && (
          <DeviceInspector
            selected={effectiveSelected}
            snapshot={data}
            hardware={hardware}
            onEditDevice={(instance) => setDeviceEditor({ open: true, instance })}
            onEditHardware={(item) => setHardwareEditor({ open: true, hardware: item })}
            onChanged={refreshAll}
          />
        )}
      </Panel>
      <DeviceEditor
        open={deviceEditor.open}
        instance={deviceEditor.instance}
        hardware={hardware}
        onClose={() => setDeviceEditor({ open: false })}
        onChanged={refreshAll}
      />
      <DevicePackagesDialog open={typesOpen} onClose={() => setTypesOpen(false)} />
      <HardwareEditor
        open={hardwareEditor.open}
        hardware={hardwareEditor.hardware}
        onClose={() => setHardwareEditor({ open: false })}
        onChanged={refreshAll}
      />
    </div>
  );
}
