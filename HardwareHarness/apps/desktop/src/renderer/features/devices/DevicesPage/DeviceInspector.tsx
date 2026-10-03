import { useState } from "react";
import type { DashboardSnapshot } from "@hardwareharness/contracts/operations";
import type { Hardware, McpServerConfig, PluginServerConfig } from "@hardwareharness/contracts/devices";
import { MousePointerClickIcon } from "lucide-react";
import { hardwareForServer } from "../../../lib/hardware.js";
import { useDeviceDefinition } from "../../../lib/queries.js";
import { EmptyState, Section } from "../../../ui";
import { ManualInvokePanel } from "../../manual/index.js";
import { AdapterRelease } from "./AdapterRelease.js";
import { HardwareActions, ServerActions } from "./DeviceActions.js";
import { DeclaredDevice } from "./DeclaredDevice.js";
import { hardwareRowStatus, modeLabel } from "./device-labels.js";
import { ErrorStrip, HardwareSections, InspectorShell, Meta, Missing } from "./inspector-parts.js";
import { LiveStreams } from "./LiveStreams.js";
import { parseDeviceSelection } from "./selection.js";

type Callbacks = {
  onEditServer: (server: PluginServerConfig) => void;
  onEditHardware: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
};

export function DeviceInspector({ selected, snapshot, hardware, ...callbacks }: Callbacks & {
  selected: string | null;
  snapshot: DashboardSnapshot;
  hardware: Hardware[];
}) {
  const selection = parseDeviceSelection(selected);
  if (selection.kind === "server") {
    const server = snapshot.servers.find((item) => item.serverId === selection.serverId);
    if (!server) return <Missing title="设备不存在" />;
    return <ManagedInspector key={selected} server={server} snapshot={snapshot} hardware={hardware} {...callbacks} />;
  }
  if (selection.kind === "passive") {
    const item = hardware.find((entry) => entry.hardwareId === selection.hardwareId && entry.kind === "passive");
    if (!item) return <Missing title="硬件不存在" />;
    return <PassiveInspector key={selected} hardware={item} {...callbacks} />;
  }
  return (
    <EmptyState
      icon={<MousePointerClickIcon />}
      title="选择一个设备或硬件"
      description="左侧列表只显示状态。点选后，详情、操作和 MCP 工具会出现在这里。"
    />
  );
}

function ManagedInspector({ server, snapshot, hardware, onEditServer, onChanged }:
  Callbacks & { server: McpServerConfig; snapshot: DashboardSnapshot; hardware: Hardware[] }) {
  const [error, setError] = useState<string | null>(null);
  const device = hardwareForServer(server, hardware);
  const serverStatus = snapshot.serverStatuses.find((item) => item.serverId === server.serverId);
  const availability = snapshot.availability?.find((item) => item.hardwareId === server.hardwareId);
  const status = hardwareRowStatus(serverStatus, availability);
  const online = serverStatus?.transport.state === "online";
  // The device's own declaration wins; the catalog record is the fallback.
  const definition = useDeviceDefinition(server.hardwareId).data;
  return (
    <InspectorShell
      title={device?.label ?? server.label}
      status={status}
      actions={
        <ServerActions
          server={server}
          onEdit={server.transport === "plugin" ? () => onEditServer(server) : undefined}
          onChanged={onChanged}
          onError={setError}
        />
      }
      notice={error && <ErrorStrip message={error} />}
    >
      <Section title="基本信息">
        <Meta items={[
          { label: "硬件 ID", value: server.hardwareId },
          { label: "Server ID", value: server.serverId },
          ...(server.transport === "plugin"
            ? [{ label: "设备类型", value: server.type }, { label: "运行模式", value: modeLabel(server.mode) }]
            : [{ label: "MCP 地址", value: server.url }])
        ]} />
        {server.transport === "mcp-http" && (
          <p className="text-xs text-fg-3">本机 MCP 服务由它自己的注册脚本登记，这里只读，可以删除。</p>
        )}
        {status.title && <p className="text-xs break-words text-fg-3">{status.title}</p>}
      </Section>
      <AdapterRelease hardwareId={server.hardwareId} onError={setError} />
      <LiveStreams hardwareId={server.hardwareId} running={online} />
      <ManualInvokePanel hardwareId={server.hardwareId} />
      {definition ? <DeclaredDevice definition={definition} /> : device && <HardwareSections hardware={device} />}
    </InspectorShell>
  );
}

function PassiveInspector({ hardware, onEditHardware, onChanged }: Callbacks & { hardware: Hardware }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <InspectorShell
      title={hardware.label}
      actions={<HardwareActions hardware={hardware} onEdit={onEditHardware} onChanged={onChanged} onError={setError} />}
      notice={error && <ErrorStrip message={error} />}
    >
      <Section title="基本信息">
        <Meta items={[
          { label: "硬件 ID", value: hardware.hardwareId }
        ]} />
      </Section>
      <HardwareSections hardware={hardware} />
    </InspectorShell>
  );
}
