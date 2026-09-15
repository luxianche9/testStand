import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Hardware, McpServerConfig, RemoteComputer } from "@hardwareharness/contracts/devices";
import { RefreshCwIcon } from "lucide-react";
import { QueryGate } from "../../../shared/layout.js";
import { invalidateDeviceData } from "../../../shared/mutations.js";
import { useDashboard, useDeviceCatalog } from "../../../shared/queries.js";
import { useResizableWidth } from "../../../shared/resizable.js";
import { cn } from "../../../shared/ui/cn";
import { Button } from "../../../shared/ui/button";
import { FeatureLayout, FeatureHeader } from "../../../shared/FeatureLayout.js";
import { DeviceInspector } from "./DeviceInspector.js";
import { HardwareListTree } from "./HardwareListTree.js";
import { RemoteComputerTree } from "./RemoteComputerTree.js";
import { ComputerEditor } from "./editors/ComputerEditor.js";
import { HardwareEditor } from "./editors/HardwareEditor.js";
import { ServerEditor } from "./editors/ServerEditor.js";

export function DevicesPage() {
  const query = useDashboard();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [computerEditor, setComputerEditor] = useState<{ open: boolean; computer?: RemoteComputer }>({ open: false });
  const [serverEditor, setServerEditor] = useState<{ open: boolean; server?: McpServerConfig; computerId?: string }>({ open: false });
  const [hardwareEditor, setHardwareEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const catalog = useDeviceCatalog();
  const sidebar = useResizableWidth({ storageKey: "hardwareharness.devices-sidebar-width", defaultWidth: 320, min: 240, max: 560, direction: "right" });

  const refreshAll = async () => invalidateDeviceData(client);
  const refreshHardware = useMutation({
    mutationFn: () => window.hardwareharness.devices.refreshManagedHardware(),
    onSettled: () => void refreshAll()
  });
  const refreshHardwareRef = useRef(refreshHardware.mutate);
  useEffect(() => { refreshHardwareRef.current = refreshHardware.mutate; }, [refreshHardware.mutate]);
  const mcpOnlineRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const statuses = query.data?.serverStatuses;
    if (!statuses) return;
    const nowOnline = new Set(statuses.filter((item) => item.transport.state === "online").map((item) => item.serverId));
    const becameOnline = [...nowOnline].filter((id) => !mcpOnlineRef.current.has(id));
    mcpOnlineRef.current = nowOnline;
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

  return <FeatureLayout
    header={
      <FeatureHeader title="设备管理">
        <Button variant="outline" size="sm" onClick={() => probeStatuses.mutate()} disabled={probeStatuses.isPending || !data}>
          <RefreshCwIcon className={cn(probeStatuses.isPending && "animate-spin")} />状态检测
        </Button>
      </FeatureHeader>
    }
    sidebar={{
      content: (
        <QueryGate query={query}>{(snapshot) => <div className="grid content-start gap-3.5">
          <RemoteComputerTree
            data={snapshot}
            hardware={hardware}
            selected={effectiveSelected}
            isOpen={isOpen}
            onSelect={setSelected}
            onToggle={toggle}
            onAddComputer={() => setComputerEditor({ open: true })}
          />
          <HardwareListTree
            hardware={hardware}
            selected={effectiveSelected}
            isOpen={isOpen}
            onSelect={setSelected}
            onToggle={toggle}
            onAddHardware={() => setHardwareEditor({ open: true })}
          />
        </div>}</QueryGate>
      ),
      width: sidebar,
      position: "left"
    }}
  >
    {data && <DeviceInspector
      selected={effectiveSelected}
      snapshot={data}
      hardware={hardware}
      onSelect={setSelected}
      onEditComputer={(computer) => setComputerEditor({ open: true, computer })}
      onAddServer={(computerId) => setServerEditor({ open: true, computerId })}
      onEditServer={(server) => setServerEditor({ open: true, server, computerId: server.computerId })}
      onEditHardware={(item) => setHardwareEditor({ open: true, hardware: item })}
      onChanged={refreshAll}
    />}
    <ComputerEditor open={computerEditor.open} computer={computerEditor.computer} onClose={() => setComputerEditor({ open: false })} onChanged={refreshAll} />
    <ServerEditor open={serverEditor.open} server={serverEditor.server} computerId={serverEditor.computerId} computers={data?.computers ?? []} hardware={hardware} onClose={() => setServerEditor({ open: false })} onChanged={refreshAll} />
    <HardwareEditor open={hardwareEditor.open} hardware={hardwareEditor.hardware} onClose={() => setHardwareEditor({ open: false })} onChanged={refreshAll} />
  </FeatureLayout>;
}
