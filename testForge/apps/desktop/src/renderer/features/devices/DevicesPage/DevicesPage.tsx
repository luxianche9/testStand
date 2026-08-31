import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Hardware, ManagedHardware, McpServerConfig, RemoteComputer, ToolCatalogItem } from "@testforge/contracts/devices";
import { RefreshCwIcon } from "lucide-react";
import { QueryGate } from "../../../shared/layout.js";
import { invalidateDeviceData } from "../../../shared/mutations.js";
import { useDashboard, useDeviceCatalog } from "../../../shared/queries.js";
import { useResizableWidth } from "../../../shared/resizable.js";
import { cn } from "../../../shared/ui/cn";
import { Button } from "../../../shared/ui/button";
import { FeatureLayout, FeatureHeader } from "../../../shared/FeatureLayout.js";
import { ManualInvokePanel } from "../../manual/index.js";
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
  const sidebar = useResizableWidth({ defaultWidth: 320, min: 240, max: 560, direction: "right" });

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
  const invokeTarget = useMemo(() => resolveInvokeTarget(effectiveSelected, data?.servers ?? [], data?.tools ?? [], data?.hardware ?? []), [data, effectiveSelected]);

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
      ),
      width: sidebar,
      position: "left"
    }}
  >
    <ManualInvokePanel hardwareId={invokeTarget.hardwareId} preferredToolName={invokeTarget.toolName} />
    <ComputerEditor open={computerEditor.open} computer={computerEditor.computer} onClose={() => setComputerEditor({ open: false })} onChanged={refreshAll} />
    <ServerEditor open={serverEditor.open} server={serverEditor.server} computerId={serverEditor.computerId} computers={data?.computers ?? []} hardware={hardware} onClose={() => setServerEditor({ open: false })} onChanged={refreshAll} />
    <HardwareEditor open={hardwareEditor.open} hardware={hardwareEditor.hardware} onClose={() => setHardwareEditor({ open: false })} onChanged={refreshAll} />
  </FeatureLayout>;
}

export function resolveInvokeTarget(
  selected: string | null,
  servers: McpServerConfig[],
  tools: ToolCatalogItem[],
  managed: ManagedHardware[]
): { hardwareId?: string; toolName?: string } {
  if (!selected) return {};
  if (selected.startsWith("t:")) {
    const toolName = selected.slice(2);
    const tool = tools.find((item) => item.externalName === toolName);
    const hardwareId = managed.find((item) => item.serverId === tool?.serverId)?.hardwareId
      ?? servers.find((item) => item.serverId === tool?.serverId)?.hardwareId;
    return hardwareId ? { hardwareId, toolName } : {};
  }
  if (selected.startsWith("s:")) {
    const serverId = selected.slice(2);
    const hardwareId = managed.find((item) => item.serverId === serverId)?.hardwareId
      ?? servers.find((item) => item.serverId === serverId)?.hardwareId;
    return hardwareId ? { hardwareId } : {};
  }
  return {};
}
