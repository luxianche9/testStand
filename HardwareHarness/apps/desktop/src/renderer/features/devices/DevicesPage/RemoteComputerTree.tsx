import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { Hardware } from "@hardwareharness/contracts/devices";
import { PlusIcon } from "lucide-react";
import { hardwareForServer } from "../../../lib/hardware.js";
import { IconButton } from "../../../ui";
import { connectionTone, hardwareRowStatus, stateLabel } from "./device-labels.js";
import { onTreeKeyDown, TreeNote, TreeRow } from "./TreeRow.js";

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
  // The local computer is always present and always reachable, so it leads the list.
  const isLocal = (computer: { execution?: string | undefined }) => Number(computer.execution === "local");
  const computers = [...data.computers].sort((a, b) => isLocal(b) - isLocal(a));
  const keys = computers.flatMap((computer) => [
    `c:${computer.id}`,
    ...data.servers.filter((item) => item.computerId === computer.id).map((item) => `s:${item.serverId}`)
  ]);
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
            {open && servers.map((server) => {
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
            })}
          </div>
        );
      })}
      {rootOpen && data.computers.length === 0 && (
        <TreeNote depth={1}>还没有电脑。点「+」添加本机或远程仪器控制电脑。</TreeNote>
      )}
    </div>
  );
}
