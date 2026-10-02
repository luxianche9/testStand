import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { Hardware, McpServerConfig } from "@hardwareharness/contracts/devices";
import { LinkIcon, PlusIcon } from "lucide-react";
import { hardwareForServer } from "../../../lib/hardware.js";
import { IconButton } from "../../../ui";
import { connectionTone, hardwareRowStatus, stateLabel } from "./device-labels.js";
import { onTreeKeyDown, TreeNote, TreeRow } from "./TreeRow.js";

/** Remote computer → managed device tree. Operations and MCP tools live in the inspector. */
export function RemoteComputerTree({
  data, hardware, selected, isOpen, onSelect, onToggle, onAddComputer, onAddByUrl
}: {
  data: DashboardSnapshot;
  hardware: Hardware[];
  selected: string | null;
  isOpen: (key: string) => boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
  onAddComputer: () => void;
  onAddByUrl: () => void;
}) {
  const rootOpen = isOpen("remotes");
  // The local computer is always present and always reachable, so it leads the list.
  const isLocal = (computer: { execution?: string | undefined }) => Number(computer.execution === "local");
  const computers = [...data.computers].sort((a, b) => isLocal(b) - isLocal(a));
  // Services added by URL have no computer: they are used, never started or stopped (design doc 4.8.3).
  const unmanaged = data.servers.filter((item) => !item.computerId);
  const keys = [
    ...computers.flatMap((computer) => [
      `c:${computer.id}`,
      ...data.servers.filter((item) => item.computerId === computer.id).map((item) => `s:${item.serverId}`)
    ]),
    "unmanaged",
    ...unmanaged.map((item) => `s:${item.serverId}`)
  ];
  const serverRow = (server: McpServerConfig) => {
    const serverKey = `s:${server.serverId}`;
    const device = hardwareForServer(server, hardware);
    const serverStatus = data.serverStatuses.find((item) => item.serverId === server.serverId);
    const availability = data.availability?.find((item) => item.hardwareId === server.hardwareId);
    return (
      <TreeRow
        key={serverKey}
        depth={2}
        label={device?.label ?? server.label}
        title={`${server.hardwareId} · ${server.serverId}`}
        status={hardwareRowStatus(serverStatus, availability)}
        selected={selected === serverKey}
        tabbable={tabStop === serverKey}
        onClick={() => onSelect(serverKey)}
      />
    );
  };
  const tabStop = selected && keys.includes(selected) ? selected : "remotes";
  return (
    <div role="tree" aria-label="电脑列表" className="py-1" onKeyDown={onTreeKeyDown}>
      <TreeRow
        depth={0}
        label="电脑列表"
        title="仪器控制电脑及其受管设备"
        className="tf-label text-fg-3"
        meta={data.computers.length}
        hasChildren
        open={rootOpen}
        selected={false}
        tabbable={tabStop === "remotes"}
        onClick={() => onToggle("remotes")}
        actions={
          <IconButton label="添加电脑" size="icon-xs" onClick={onAddComputer}><PlusIcon /></IconButton>
        }
      />
      {rootOpen && computers.map((computer) => {
        const key = `c:${computer.id}`;
        const open = isOpen(key);
        const servers = data.servers.filter((item) => item.computerId === computer.id);
        const ssh = data.statuses.find((item) => item.computerId === computer.id)?.ssh;
        const state = ssh?.state ?? "unknown";
        return (
          <div key={key} role="none">
            <TreeRow
              depth={1}
              label={computer.label}
              title={`${computer.id} · ${computer.address}`}
              status={computer.execution === "local" ? undefined : {
                tone: connectionTone(state),
                pulse: state === "checking",
                label: stateLabel(state),
                title: ssh?.message
              }}
              hasChildren
              open={open}
              selected={selected === key}
              tabbable={tabStop === key}
              onClick={() => { onSelect(key); if (!open) onToggle(key); }}
              onToggle={() => onToggle(key)}
            />
            {open && servers.map(serverRow)}
          </div>
        );
      })}
      {rootOpen && data.computers.length === 0 && (
        <TreeNote depth={1}>还没有电脑。点「+」添加本机或远程仪器控制电脑。</TreeNote>
      )}
      {rootOpen && (
        <div role="none">
          <TreeRow
            depth={1}
            label="未托管服务"
            title="按 URL 添加的服务：可以使用，但不由 HardwareHarness 启动或停止"
            meta={unmanaged.length}
            hasChildren={unmanaged.length > 0}
            open={isOpen("unmanaged")}
            selected={false}
            tabbable={tabStop === "unmanaged"}
            onClick={() => onToggle("unmanaged")}
            onToggle={() => onToggle("unmanaged")}
            actions={
              <IconButton label="按 URL 添加服务" size="icon-xs" onClick={onAddByUrl}><LinkIcon /></IconButton>
            }
          />
          {isOpen("unmanaged") && unmanaged.map(serverRow)}
        </div>
      )}
    </div>
  );
}
