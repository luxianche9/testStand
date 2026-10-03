import { useState } from "react";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { Hardware, McpHttpServerConfig, RemoteComputer } from "@hardwareharness/contracts/devices";
import { MousePointerClickIcon } from "lucide-react";
import { hardwareForServer } from "../../../lib/hardware.js";
import { useDeviceDefinition } from "../../../lib/queries.js";
import { EmptyState, Section, StatusLamp, toneText, cn } from "../../../ui";
import { ManualInvokePanel } from "../../manual/index.js";
import { AdapterRelease } from "./AdapterRelease.js";
import { ComputerActions, HardwareActions, ServerActions, ServiceControls } from "./DeviceActions.js";
import { DeclaredDevice } from "./DeclaredDevice.js";
import { connectionTone, hardwareRowStatus, stateLabel } from "./device-labels.js";
import { ErrorStrip, HardwareSections, InspectorShell, Meta, Missing } from "./inspector-parts.js";
import { LiveStreams } from "./LiveStreams.js";
import { parseDeviceSelection } from "./selection.js";

type Callbacks = {
  onSelect: (key: string) => void;
  onEditComputer: (computer: RemoteComputer) => void;
  onAddServer: (computerId: string) => void;
  onEditServer: (server: McpHttpServerConfig) => void;
  onEditHardware: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
};

export function DeviceInspector({ selected, snapshot, hardware, ...callbacks }: Callbacks & {
  selected: string | null;
  snapshot: DashboardSnapshot;
  hardware: Hardware[];
}) {
  const selection = parseDeviceSelection(selected);
  if (selection.kind === "computer") {
    const computer = snapshot.computers.find((item) => item.id === selection.computerId);
    if (!computer) return <Missing title="电脑不存在" />;
    return (
      <ComputerInspector key={selected} computer={computer} snapshot={snapshot} hardware={hardware} {...callbacks} />
    );
  }
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
      title="选择一台电脑或设备"
      description="左侧树只显示状态。点选后，详情、操作和 MCP 工具会出现在这里。"
    />
  );
}

function ComputerInspector({ computer, snapshot, hardware, onSelect, onEditComputer, onAddServer, onChanged }:
  Callbacks & { computer: RemoteComputer; snapshot: DashboardSnapshot; hardware: Hardware[] }) {
  const [error, setError] = useState<string | null>(null);
  const ssh = snapshot.statuses.find((item) => item.computerId === computer.id)?.ssh;
  const sshState = ssh?.state ?? "unknown";
  const servers = snapshot.servers.filter((item) => item.computerId === computer.id);
  const local = computer.execution === "local";
  // The local shell needs no link check, and a healthy remote link is already lit in the tree.
  const status = local || sshState === "online" || sshState === "unknown" ? undefined : {
    label: stateLabel(sshState),
    tone: connectionTone(sshState),
    title: ssh?.message
  };
  return (
    <InspectorShell
      title={computer.label}
      status={status}
      actions={
        <ComputerActions
          computer={computer}
          onEdit={() => onEditComputer(computer)}
          onAddServer={() => onAddServer(computer.id)}
          onChanged={onChanged}
          onError={setError}
        />
      }
      notice={error && <ErrorStrip message={error} />}
    >
      <Section title="基本信息">
        <Meta items={[
          { label: "ID", value: computer.id },
          { label: "运行位置", value: local ? "本机" : "远程电脑（SSH）" },
          ...(local ? [] : [
            { label: "地址", value: computer.address },
            { label: "SSH 端口", value: String(computer.ssh.port) },
            { label: "SSH 用户", value: computer.ssh.username }
          ]),
          { label: "Shell", value: computer.ssh.shell },
          ...(ssh?.latencyMs !== undefined ? [{ label: "延迟", value: `${ssh.latencyMs} ms` }] : [])
        ]} />
        {ssh?.message && sshState !== "online" && <p className="text-xs break-words text-fg-3">{ssh.message}</p>}
      </Section>
      <Section title="设备" actions={<span className="tf-num text-2xs text-fg-3">{servers.length}</span>}>
        {servers.length === 0 && (
          <p className="text-xs text-fg-3">还没有设备。点「添加 MCP Server」为这块电脑登记受管硬件。</p>
        )}
        {servers.length > 0 && (
          <ul className="overflow-hidden rounded-md border border-line">
            {servers.map((server) => {
              const device = hardwareForServer(server, hardware);
              const status = hardwareRowStatus(
                snapshot.serverStatuses.find((item) => item.serverId === server.serverId),
                snapshot.availability?.find((item) => item.hardwareId === server.hardwareId)
              );
              return (
                <li key={server.serverId} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    className={cn(
                      "flex h-7 w-full items-center gap-2 px-2 text-left text-sm text-fg-2 outline-none",
                      "hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2"
                    )}
                    onClick={() => onSelect(`s:${server.serverId}`)}
                  >
                    <StatusLamp tone={status.tone} pulse={status.pulse ?? false} className="size-1.5" />
                    <span className="min-w-0 flex-1 truncate" title={server.hardwareId}>
                      {device?.label ?? server.label}
                    </span>
                    <span className={cn("text-2xs", toneText[status.tone])}>{status.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </InspectorShell>
  );
}

function ManagedInspector({ server, snapshot, hardware, onEditServer, onChanged }:
  Callbacks & { server: McpHttpServerConfig; snapshot: DashboardSnapshot; hardware: Hardware[] }) {
  const [error, setError] = useState<string | null>(null);
  const device = hardwareForServer(server, hardware);
  const computer = snapshot.computers.find((item) => item.id === server.computerId);
  const serverStatus = snapshot.serverStatuses.find((item) => item.serverId === server.serverId);
  const availability = snapshot.availability?.find((item) => item.hardwareId === server.hardwareId);
  const sshOnline = snapshot.statuses.find((item) => item.computerId === server.computerId)?.ssh.state === "online";
  const status = hardwareRowStatus(serverStatus, availability);
  const title = device?.label ?? server.label;
  const online = serverStatus?.transport.state === "online";
  // The service's own declaration wins; the catalog record is the fallback for older services.
  const definition = useDeviceDefinition(server.hardwareId).data;
  return (
    <InspectorShell
      title={title}
      status={status}
      actions={
        <ServerActions
          server={server}
          computer={computer}
          onEdit={() => onEditServer(server)}
          onChanged={onChanged}
          onError={setError}
        />
      }
      notice={error && <ErrorStrip message={error} />}
    >
      <Section title="基本信息">
        <Meta items={[
          { label: "硬件 ID", value: server.hardwareId },
          { label: "所属电脑", value: computer?.label ?? server.computerId ?? "未托管（按 URL 添加）" },
          { label: "MCP Server", value: server.serverId },
          { label: "MCP 地址", value: server.url }
        ]} />
        {status.title && <p className="text-xs break-words text-fg-3">{status.title}</p>}
      </Section>
      <Section title="服务">
        {server.computerId ? (
          <ServiceControls
            server={server}
            status={serverStatus}
            sshOnline={sshOnline}
            onChanged={onChanged}
            onError={setError}
          />
        ) : (
          <p className="text-xs text-fg-3">未托管：这个服务按 URL 添加，只能使用，不能在这里启动、停止或读日志。</p>
        )}
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
