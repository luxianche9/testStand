import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Hardware, McpServerConfig, RemoteComputer } from "@hardwareharness/contracts/devices";
import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { errorMessage } from "../../../lib/errors.js";
import { invalidateDeviceData } from "../../../lib/mutations.js";
import { useDashboard, useDeviceCatalog } from "../../../lib/queries.js";
import { useResizableWidth } from "../../../lib/resizable.js";
import { Button, cn, EmptyState, Panel, PanelBody, PanelHeader, Spinner, Splitter } from "../../../ui";
import { DeviceInspector } from "./DeviceInspector.js";
import { HardwareListTree } from "./HardwareListTree.js";
import { RemoteComputerTree } from "./RemoteComputerTree.js";
import { ComputerEditor } from "./editors/ComputerEditor.js";
import { HardwareEditor } from "./editors/HardwareEditor.js";
import { ServerEditor } from "./editors/ServerEditor.js";
import { AddServerByUrlDialog } from "./editors/ServiceDialogs.js";

type ServerEditorState = { open: boolean; server?: McpServerConfig; computerId?: string };

export function DevicesPage() {
  const query = useDashboard();
  const catalog = useDeviceCatalog();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [computerEditor, setComputerEditor] = useState<{ open: boolean; computer?: RemoteComputer }>({ open: false });
  const [serverEditor, setServerEditor] = useState<ServerEditorState>({ open: false });
  const [hardwareEditor, setHardwareEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const [addByUrlOpen, setAddByUrlOpen] = useState(false);
  const sidebar = useResizableWidth({
    storageKey: "hardwareharness.devices-sidebar-width",
    defaultWidth: 320,
    min: 240,
    max: 560,
    direction: "right"
  });

  const refreshAll = async () => invalidateDeviceData(client);
  const refreshHardware = useMutation({
    mutationFn: () => window.hardwareharness.devices.refreshManagedHardware(),
    onSettled: () => void refreshAll()
  });
  const refreshHardwareRef = useRef(refreshHardware.mutate);
  useEffect(() => { refreshHardwareRef.current = refreshHardware.mutate; }, [refreshHardware.mutate]);
  // Re-read hardware descriptors whenever an MCP server comes online (its list_hardware may have changed).
  const mcpOnlineRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const statuses = query.data?.serverStatuses;
    if (!statuses) return;
    const online = statuses.filter((item) => item.transport.state === "online").map((item) => item.serverId);
    const becameOnline = online.filter((id) => !mcpOnlineRef.current.has(id));
    mcpOnlineRef.current = new Set(online);
    if (becameOnline.length > 0) refreshHardwareRef.current();
  }, [query.data?.serverStatuses]);

  const probeStatuses = useMutation({
    mutationFn: async () => {
      const snapshot = query.data;
      if (!snapshot) return;
      await Promise.allSettled([
        ...snapshot.computers.map((computer) => window.hardwareharness.devices.refreshComputer(computer.id)),
        ...snapshot.servers.map((server) => window.hardwareharness.devices.refreshServer(server.serverId))
      ]);
      try {
        await window.hardwareharness.devices.refreshManagedHardware();
      } catch {
        // Partial MCP outages are reflected in the per-server statuses above.
      }
    },
    onSettled: () => void refreshAll()
  });

  const isOpen = (key: string) => expanded[key] ?? true;
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  const data = query.data;
  const hardware = catalog.data?.hardware ?? [];
  const firstComputer = data?.computers[0];
  const firstPassive = hardware.find((item) => item.kind === "passive");
  const effectiveSelected = selected
    ?? (firstComputer ? `c:${firstComputer.id}` : firstPassive ? `l:${firstPassive.hardwareId}` : null);

  return (
    <div
      className="grid h-full min-h-0 bg-surface-0"
      style={{ gridTemplateColumns: `${sidebar.width}px 1px minmax(0,1fr)` }}
    >
      <Panel as="aside" aria-label="设备树">
        <PanelHeader
          title="设备管理"
          actions={
            <Button
              size="xs"
              variant="ghost"
              title="检测所有电脑的 SSH 连接与 MCP Server 状态"
              disabled={probeStatuses.isPending || !data}
              onClick={() => probeStatuses.mutate()}
            >
              <RefreshCwIcon className={cn(probeStatuses.isPending && "animate-spin")} />状态检测
            </Button>
          }
        />
        <PanelBody>
          {data ? (
            <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-1 pb-3">
              <RemoteComputerTree
                data={data}
                hardware={hardware}
                selected={effectiveSelected}
                isOpen={isOpen}
                onSelect={setSelected}
                onToggle={toggle}
                onAddComputer={() => setComputerEditor({ open: true })}
                onAddByUrl={() => setAddByUrlOpen(true)}
              />
              <HardwareListTree
                hardware={hardware}
                selected={effectiveSelected}
                isOpen={isOpen}
                onSelect={setSelected}
                onToggle={toggle}
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
            onSelect={setSelected}
            onEditComputer={(computer) => setComputerEditor({ open: true, computer })}
            onAddServer={(computerId) => setServerEditor({ open: true, computerId })}
            onEditServer={(server) =>
              setServerEditor({ open: true, server, ...(server.computerId ? { computerId: server.computerId } : {}) })}
            onEditHardware={(item) => setHardwareEditor({ open: true, hardware: item })}
            onChanged={refreshAll}
          />
        )}
      </Panel>
      <ComputerEditor
        open={computerEditor.open}
        computer={computerEditor.computer}
        onClose={() => setComputerEditor({ open: false })}
        onChanged={refreshAll}
      />
      <ServerEditor
        open={serverEditor.open}
        server={serverEditor.server}
        computerId={serverEditor.computerId}
        computers={data?.computers ?? []}
        hardware={hardware}
        onClose={() => setServerEditor({ open: false })}
        onChanged={refreshAll}
      />
      <AddServerByUrlDialog
        open={addByUrlOpen}
        onClose={() => setAddByUrlOpen(false)}
        onAdded={async (serverId) => { await refreshAll(); setSelected(`s:${serverId}`); }}
      />
      <HardwareEditor
        open={hardwareEditor.open}
        hardware={hardwareEditor.hardware}
        onClose={() => setHardwareEditor({ open: false })}
        onChanged={refreshAll}
      />
    </div>
  );
}
