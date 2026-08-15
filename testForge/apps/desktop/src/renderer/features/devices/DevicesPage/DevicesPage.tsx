import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { DashboardSnapshot } from "@testforge/contracts/desktop";
import type { Hardware, McpServerConfig, RemoteComputer } from "@testforge/contracts/devices";
import { IconRefresh } from "../../../shared/icons.js";
import { PageHeader, QueryGate } from "../../../shared/layout.js";
import { invalidateDeviceData } from "../../../shared/mutations.js";
import { useDeviceCatalog } from "../../../shared/queries.js";
import { Btn } from "../../../shared/ui.js";
import { HardwareListTree } from "./HardwareListTree.js";
import { RemoteComputerTree } from "./RemoteComputerTree.js";
import { ComputerEditor } from "./editors/ComputerEditor.js";
import { HardwareEditor } from "./editors/HardwareEditor.js";
import { ServerEditor } from "./editors/ServerEditor.js";

export function DevicesPage({ query }: { query: UseQueryResult<DashboardSnapshot> }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [computerEditor, setComputerEditor] = useState<{ open: boolean; computer?: RemoteComputer }>({ open: false });
  const [serverEditor, setServerEditor] = useState<{ open: boolean; server?: McpServerConfig; computerId?: string }>({ open: false });
  const [hardwareEditor, setHardwareEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const catalog = useDeviceCatalog();

  const refreshAll = async () => invalidateDeviceData(client);
  const refreshHardware = useMutation({
    mutationFn: () => window.testforge.devices.refreshManagedHardware(),
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
        ...snapshot.computers.map((computer) => window.testforge.devices.refreshComputer(computer.id)),
        ...snapshot.servers.map((server) => window.testforge.devices.refreshServer(server.serverId))
      ]);
      try {
        await window.testforge.devices.refreshManagedHardware();
      } catch {
        // Partial MCP outages are reflected in the per-server statuses above.
      }
    },
    onSettled: () => void refreshAll()
  });

  const isOpen = (key: string) => expanded[key] ?? !key.startsWith("t:");
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !(current[key] ?? !key.startsWith("t:")) }));
  const data = query.data;
  const hardware = catalog.data?.hardware ?? [];
  const effectiveSelected = selected ?? (data?.computers[0] ? `c:${data.computers[0].id}` : null);

  return <main className="page">
    <div className="page-inner">
      <PageHeader title="设备管理" actions={<Btn icon={<IconRefresh size={14} className={probeStatuses.isPending ? "spin" : undefined} />} onClick={() => probeStatuses.mutate()} disabled={probeStatuses.isPending || !data}>状态检测</Btn>} />
      <QueryGate query={query}>{(snapshot) => <div className="device-trees">
        <RemoteComputerTree
          data={snapshot}
          selected={effectiveSelected}
          isOpen={isOpen}
          onSelect={setSelected}
          onToggle={toggle}
          onAddComputer={() => setComputerEditor({ open: true })}
          onEditComputer={(computer) => setComputerEditor({ open: true, computer })}
          onAddServer={(computerId) => setServerEditor({ open: true, computerId })}
          onEditServer={(server) => setServerEditor({ open: true, server, computerId: server.computerId })}
          onChanged={refreshAll}
        />
        <HardwareListTree
          hardware={hardware}
          selected={effectiveSelected}
          isOpen={isOpen}
          onSelect={setSelected}
          onToggle={toggle}
          onAddHardware={() => setHardwareEditor({ open: true })}
          onEditHardware={(item) => setHardwareEditor({ open: true, hardware: item })}
          onChanged={refreshAll}
        />
      </div>}</QueryGate>
    </div>
    <ComputerEditor open={computerEditor.open} computer={computerEditor.computer} onClose={() => setComputerEditor({ open: false })} onChanged={refreshAll} />
    <ServerEditor open={serverEditor.open} server={serverEditor.server} computerId={serverEditor.computerId} computers={data?.computers ?? []} hardware={hardware} onClose={() => setServerEditor({ open: false })} onChanged={refreshAll} />
    <HardwareEditor open={hardwareEditor.open} hardware={hardwareEditor.hardware} onClose={() => setHardwareEditor({ open: false })} onChanged={refreshAll} />
  </main>;
}
