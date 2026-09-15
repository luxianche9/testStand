import type { ReactNode } from "react";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { Hardware, McpServerConfig, RemoteComputer } from "@hardwareharness/contracts/devices";
import { CpuIcon, MonitorIcon } from "lucide-react";
import { hardwareForServer } from "../../../shared/hardware.js";
import { Badge, badgeVariantFromTone } from "../../../shared/ui/badge";
import { EmptyState } from "../../../shared/ui/empty-state";
import { ManualInvokePanel } from "../../manual/index.js";
import { HardwareImage } from "../HardwareImage.js";
import { ComputerActions, HardwareActions, ServerActions } from "./DeviceActions.js";
import { connectionDot, mcpRowStatuses, stateLabel } from "./device-labels.js";
import { parseDeviceSelection } from "./selection.js";

export function DeviceInspector({ selected, snapshot, hardware, onSelect, onEditComputer, onAddServer, onEditServer, onEditHardware, onChanged }: {
  selected: string | null;
  snapshot: DashboardSnapshot;
  hardware: Hardware[];
  onSelect: (key: string) => void;
  onEditComputer: (computer: RemoteComputer) => void;
  onAddServer: (computerId: string) => void;
  onEditServer: (server: McpServerConfig) => void;
  onEditHardware: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
}) {
  const selection = parseDeviceSelection(selected);
  if (selection.kind === "computer") {
    const computer = snapshot.computers.find((item) => item.id === selection.computerId);
    if (!computer) return <Missing title="电脑不存在" />;
    return <ComputerInspector computer={computer} snapshot={snapshot} hardware={hardware} onSelect={onSelect} onEditComputer={onEditComputer} onAddServer={onAddServer} onChanged={onChanged} />;
  }
  if (selection.kind === "server") {
    const server = snapshot.servers.find((item) => item.serverId === selection.serverId);
    if (!server) return <Missing title="设备不存在" />;
    return <ManagedInspector server={server} snapshot={snapshot} hardware={hardware} onEditServer={onEditServer} onChanged={onChanged} />;
  }
  if (selection.kind === "passive") {
    const item = hardware.find((entry) => entry.hardwareId === selection.hardwareId && entry.kind === "passive");
    if (!item) return <Missing title="硬件不存在" />;
    return <PassiveInspector hardware={item} onEditHardware={onEditHardware} onChanged={onChanged} />;
  }
  return <EmptyState className="m-auto" title="选择一台电脑或设备" body="左侧树只显示状态。点选后，详情、操作和 MCP 工具会出现在这里。" />;
}

function ComputerInspector({ computer, snapshot, hardware, onSelect, onEditComputer, onAddServer, onChanged }: {
  computer: RemoteComputer;
  snapshot: DashboardSnapshot;
  hardware: Hardware[];
  onSelect: (key: string) => void;
  onEditComputer: (computer: RemoteComputer) => void;
  onAddServer: (computerId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const status = snapshot.statuses.find((item) => item.computerId === computer.id);
  const sshState = status?.ssh.state ?? "unknown";
  const servers = snapshot.servers.filter((item) => item.computerId === computer.id);
  return <InspectorShell
    icon={<MonitorIcon className="size-5" />}
    title={computer.label}
    subtitle={computer.id}
    badges={[{ label: `${computer.execution === "local" ? "本机" : "SSH"} ${stateLabel(sshState)}`, tone: toneFromDot(connectionDot(sshState)) }]}
    actions={<ComputerActions computer={computer} onEdit={() => onEditComputer(computer)} onAddServer={() => onAddServer(computer.id)} onChanged={onChanged} />}
  >
    <Meta items={[
      { label: "运行位置", value: computer.execution === "local" ? "本机" : "远程电脑（SSH）" },
      { label: "地址", value: computer.address },
      ...(computer.execution === "local" ? [] : [
        { label: "SSH 端口", value: String(computer.ssh.port) },
        { label: "SSH 用户", value: computer.ssh.username }
      ]),
      { label: "Shell", value: computer.ssh.shell }
    ]} />
    <section className="grid gap-2">
      <h3 className="m-0 text-sm font-semibold">设备</h3>
      {servers.length === 0 && <p className="m-0 text-xs text-muted-foreground">还没有设备。点「添加 MCP Server」为这块电脑登记受管硬件。</p>}
      {servers.map((server) => {
        const device = hardwareForServer(server, hardware);
        const serverStatus = snapshot.serverStatuses.find((item) => item.serverId === server.serverId);
        const online = mcpRowStatuses(serverStatus)[0];
        return <button
          key={server.serverId}
          type="button"
          className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-left text-sm shadow-sm ring-1 ring-border transition-colors hover:bg-accent"
          onClick={() => onSelect(`s:${server.serverId}`)}
        >
          <CpuIcon className="size-4 flex-none text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{device?.label ?? server.label}</span>
          <span className="text-xs text-muted-foreground">{online?.label}</span>
        </button>;
      })}
    </section>
  </InspectorShell>;
}

function ManagedInspector({ server, snapshot, hardware, onEditServer, onChanged }: {
  server: McpServerConfig;
  snapshot: DashboardSnapshot;
  hardware: Hardware[];
  onEditServer: (server: McpServerConfig) => void;
  onChanged: () => Promise<void>;
}) {
  const device = hardwareForServer(server, hardware);
  const computer = snapshot.computers.find((item) => item.id === server.computerId);
  const serverStatus = snapshot.serverStatuses.find((item) => item.serverId === server.serverId);
  const availability = snapshot.availability?.find((item) => item.hardwareId === server.hardwareId)?.state ?? "checking";
  const sshOnline = snapshot.statuses.find((item) => item.computerId === server.computerId)?.ssh.state === "online";
  const online = mcpRowStatuses(serverStatus)[0];
  return <InspectorShell
    icon={<CpuIcon className="size-5" />}
    title={device?.label ?? server.label}
    subtitle={server.hardwareId}
    badges={[
      { label: online?.label ?? "离线", tone: toneFromDot(online?.dot ?? "muted") },
      { label: availability, tone: availability === "available" ? "ok" : availability === "faulted" ? "bad" : availability === "checking" ? "accent" : "muted" }
    ]}
    actions={<ServerActions server={server} status={serverStatus} sshOnline={sshOnline} onEdit={() => onEditServer(server)} onChanged={onChanged} />}
  >
    <Meta items={[
      { label: "硬件 ID", value: server.hardwareId },
      { label: "所属电脑", value: computer?.label ?? server.computerId },
      { label: "MCP Server", value: server.serverId },
      { label: "MCP 地址", value: server.url },
      { label: "进程", value: serverStatus?.service.serviceState ?? "unknown" }
    ]} />
    {device && <HardwareGallery hardware={device} />}
    <ManualInvokePanel hardwareId={server.hardwareId} />
  </InspectorShell>;
}

function PassiveInspector({ hardware, onEditHardware, onChanged }: {
  hardware: Hardware;
  onEditHardware: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
}) {
  return <InspectorShell
    icon={<CpuIcon className="size-5" />}
    title={hardware.label}
    subtitle={hardware.hardwareId}
    badges={[{ label: "被动硬件", tone: "muted" }]}
    actions={<HardwareActions hardware={hardware} onEdit={onEditHardware} onChanged={onChanged} />}
  >
    <Meta items={[
      { label: "硬件 ID", value: hardware.hardwareId },
      { label: "端口", value: `${hardware.ports.length} 个` }
    ]} />
    <HardwareGallery hardware={hardware} />
  </InspectorShell>;
}

function HardwareGallery({ hardware }: { hardware: Hardware }) {
  if (!hardware.appearanceAssetId && hardware.ports.length === 0) return null;
  return <div className="grid gap-3">
    {hardware.appearanceAssetId && (
      <figure className="m-0 overflow-hidden rounded-xl bg-secondary/40 ring-1 ring-border">
        <HardwareImage hardwareId={hardware.hardwareId} assetId={hardware.appearanceAssetId} alt={`${hardware.label} 外观图`} className="max-h-[280px] w-full" />
        <figcaption className="px-3 py-2 text-xs text-muted-foreground">外观图</figcaption>
      </figure>
    )}
    {hardware.ports.map((port) => (
      <article className="rounded-xl bg-card p-3 shadow-sm ring-1 ring-border" key={port.portId}>
        <header className="mb-2 flex flex-wrap items-center gap-2">
          <strong className="text-sm">{port.name}</strong>
          <span className="font-mono text-[11px] text-muted-foreground">{port.portId}</span>
          <Badge variant={port.pins.length ? "secondary" : "default"}>{port.pins.length ? `${port.pins.length} 针` : "无针脚"}</Badge>
        </header>
        {port.imageAssetId && <HardwareImage hardwareId={hardware.hardwareId} assetId={port.imageAssetId} alt={`${port.name} 端口图`} className="mb-2 max-h-[180px] rounded-md" />}
        {port.pins.length > 0 && (
          <ul className="m-0 grid list-none gap-1 p-0 text-xs">
            {port.pins.map((pin) => (
              <li className="flex gap-2" key={pin.pinId}>
                <span className="w-6 flex-none text-right text-muted-foreground">{pin.position}</span>
                <code className="font-mono">{pin.pinId}</code>
                {pin.label && <span className="text-muted-foreground">{pin.label}</span>}
              </li>
            ))}
          </ul>
        )}
      </article>
    ))}
  </div>;
}

function InspectorShell({ icon, title, subtitle, badges, actions, children }: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  badges: { label: string; tone: Parameters<typeof badgeVariantFromTone>[0] }[];
  actions: ReactNode;
  children: ReactNode;
}) {
  return <section className="min-h-0 min-w-0 flex-1 overflow-auto px-5 pt-4 pb-9">
    <header className="mb-4 grid gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-8 flex-none place-items-center rounded-md bg-secondary text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-lg font-semibold">{title}</h2>
          <small className="mt-1 block font-mono text-[11px] text-muted-foreground">{subtitle}</small>
          <div className="mt-2 flex flex-wrap gap-1.5">{badges.map((badge) => <Badge key={badge.label} variant={badgeVariantFromTone(badge.tone)}>{badge.label}</Badge>)}</div>
        </div>
      </div>
      {actions}
    </header>
    <div className="grid gap-5">{children}</div>
  </section>;
}

function Meta({ items }: { items: { label: string; value: ReactNode }[] }) {
  return <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
    {items.map((item) => <div className="contents" key={item.label}>
      <dt className="text-muted-foreground">{item.label}</dt>
      <dd className="m-0 min-w-0 break-all">{item.value}</dd>
    </div>)}
  </dl>;
}

function Missing({ title }: { title: string }) {
  return <EmptyState className="m-auto" title={title} body="它可能已被删除。请从左侧重新选择。" />;
}

function toneFromDot(dot: string): Parameters<typeof badgeVariantFromTone>[0] {
  if (dot === "ok") return "ok";
  if (dot === "warn") return "warn";
  if (dot === "bad") return "bad";
  if (dot === "checking") return "accent";
  return "muted";
}
