import type { DashboardSnapshot } from "@hardwareharness/contracts/operations";
import type { Hardware, McpServerConfig } from "@hardwareharness/contracts/devices";
import { PlusIcon } from "lucide-react";
import { hardwareForServer } from "../../../lib/hardware.js";
import { IconButton } from "../../../ui";
import { hardwareRowStatus } from "./device-labels.js";
import { onTreeKeyDown, TreeNote, TreeRow } from "./TreeRow.js";

/**
 * Every hardware instance on this PC: devices loaded into the backend (plugins and local MCP services) and
 * passive hardware (DUTs, fixtures). Rows show status only; operations and MCP tools live in the inspector.
 */
export function HardwareListTree({
  data, hardware, selected, isOpen, onSelect, onToggle, onAddDevice, onAddHardware
}: {
  data: DashboardSnapshot;
  hardware: Hardware[];
  selected: string | null;
  isOpen: (key: string) => boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
  onAddDevice: () => void;
  onAddHardware: () => void;
}) {
  const passive = hardware.filter((item) => item.kind === "passive");
  const devicesOpen = isOpen("devices");
  const hardwareOpen = isOpen("hardware");
  const keys = [
    ...data.servers.map((item) => `s:${item.serverId}`),
    ...passive.map((item) => `l:${item.hardwareId}`)
  ];
  const tabStop = selected && keys.includes(selected) ? selected : "devices";
  const serverRow = (server: McpServerConfig) => {
    const key = `s:${server.serverId}`;
    const device = hardwareForServer(server, hardware);
    const status = hardwareRowStatus(
      data.serverStatuses.find((item) => item.serverId === server.serverId),
      data.availability?.find((item) => item.hardwareId === server.hardwareId)
    );
    return (
      <TreeRow
        key={key}
        depth={1}
        label={device?.label ?? server.label}
        title={`${server.hardwareId} · ${server.serverId}`}
        status={status}
        selected={selected === key}
        tabbable={tabStop === key}
        onClick={() => onSelect(key)}
      />
    );
  };
  return (
    <div role="tree" aria-label="硬件列表" className="py-1" onKeyDown={onTreeKeyDown}>
      <TreeRow
        depth={0}
        label="设备"
        title="加载到本机后端的设备插件与本机 MCP 服务"
        className="tf-label text-fg-3"
        meta={data.servers.length}
        hasChildren
        open={devicesOpen}
        selected={false}
        tabbable={tabStop === "devices"}
        onClick={() => onToggle("devices")}
        actions={
          <IconButton label="添加测试资源" size="icon-xs" onClick={onAddDevice}><PlusIcon /></IconButton>
        }
      />
      {devicesOpen && data.servers.map(serverRow)}
      {devicesOpen && data.servers.length === 0 && (
        <TreeNote depth={1}>还没有设备。点「+」从已安装的设备类型添加测试资源。</TreeNote>
      )}
      <TreeRow
        depth={0}
        label="被动硬件"
        title="被测对象、夹具等不由设备插件控制的硬件"
        className="tf-label text-fg-3"
        meta={passive.length}
        hasChildren
        open={hardwareOpen}
        selected={false}
        tabbable={false}
        onClick={() => onToggle("hardware")}
        actions={
          <IconButton label="添加被动硬件" size="icon-xs" onClick={onAddHardware}><PlusIcon /></IconButton>
        }
      />
      {hardwareOpen && passive.map((item) => {
        const key = `l:${item.hardwareId}`;
        return (
          <TreeRow
            key={key}
            depth={1}
            label={item.label}
            title={`${item.hardwareId} · ${item.ports.length} 个端口`}
            selected={selected === key}
            tabbable={tabStop === key}
            onClick={() => onSelect(key)}
          />
        );
      })}
      {hardwareOpen && passive.length === 0 && (
        <TreeNote depth={1}>还没有被动硬件。被测对象和夹具在这里登记后才能进入接线画布。</TreeNote>
      )}
    </div>
  );
}
