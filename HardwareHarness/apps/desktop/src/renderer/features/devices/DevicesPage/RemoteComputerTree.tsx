import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { Hardware } from "@hardwareharness/contracts/devices";
import { CpuIcon, MonitorIcon, PlusIcon } from "lucide-react";
import { hardwareForServer } from "../../../shared/hardware.js";
import { TooltipIconButton } from "../../../shared/ui/checkbox";
import { connectionDot, mcpRowStatuses, stateLabel } from "./device-labels.js";
import { InlineDetail, TreeRow } from "./TreeRow.js";

/** Remote computer → managed device tree. Operations and MCP tools live in the inspector. */
export function RemoteComputerTree({ data, hardware, selected, isOpen, onSelect, onToggle, onAddComputer }: {
  data: DashboardSnapshot;
  hardware: Hardware[];
  selected: string | null;
  isOpen: (key: string) => boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
  onAddComputer: () => void;
}) {
  const rootOpen = isOpen("remotes");
  return <div className="min-w-0 overflow-hidden rounded-lg bg-card shadow-[var(--tf-shadow-sm)] ring-1 ring-border" role="tree" aria-label="电脑列表">
    <div>
      <TreeRow
        className="h-9 bg-secondary/60 font-semibold"
        depth={0}
        icon={<MonitorIcon className="size-4" />}
        label="电脑列表"
        title="仪器控制电脑及其受管设备"
        hasChildren
        open={rootOpen}
        selected={false}
        onClick={() => onToggle("remotes")}
        actions={<span className="flex flex-none items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
          <TooltipIconButton tooltip="添加电脑" aria-label="添加电脑" onClick={(event) => { event.stopPropagation(); onAddComputer(); }}><PlusIcon /></TooltipIconButton>
        </span>}
      />
      {rootOpen && data.computers.map((computer) => {
        const key = `c:${computer.id}`;
        const open = isOpen(key);
        const servers = data.servers.filter((item) => item.computerId === computer.id);
        const status = data.statuses.find((item) => item.computerId === computer.id);
        return <div key={key}>
          <TreeRow
            depth={1}
            icon={<MonitorIcon className="size-4" />}
            label={computer.label}
            title={`${computer.id} · ${computer.address}`}
            statuses={[{ dot: connectionDot(status?.ssh.state ?? "unknown"), label: `${computer.execution === "local" ? "本机" : "SSH"} ${stateLabel(status?.ssh.state ?? "unknown")}`, title: status?.ssh.message }]}
            hasChildren
            open={open}
            selected={selected === key}
            onClick={() => { onSelect(key); onToggle(key); }}
          />
          {open && servers.map((server) => {
            const serverKey = `s:${server.serverId}`;
            const device = hardwareForServer(server, hardware);
            const serverStatus = data.serverStatuses.find((item) => item.serverId === server.serverId);
            return <TreeRow
              key={serverKey}
              depth={2}
              icon={<CpuIcon className="size-4" />}
              label={device?.label ?? server.label}
              title={`${server.hardwareId} · ${server.serverId}`}
              statuses={mcpRowStatuses(serverStatus, data.availability?.find((item) => item.hardwareId === server.hardwareId))}
              selected={selected === serverKey}
              onClick={() => onSelect(serverKey)}
            />;
          })}
          {open && servers.length === 0 && <InlineDetail depth={2}><p className="m-0 text-xs text-muted-foreground">还没有设备。选中这台电脑后，在右侧添加 MCP Server。</p></InlineDetail>}
        </div>;
      })}
      {rootOpen && data.computers.length === 0 && <InlineDetail depth={1}><p className="m-0 text-xs text-muted-foreground">还没有电脑。点右侧“+”添加本机或远程仪器控制电脑。</p></InlineDetail>}
    </div>
  </div>;
}
