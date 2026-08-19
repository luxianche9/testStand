import type { DashboardSnapshot } from "@testforge/contracts/desktop";
import type { McpServerConfig, RemoteComputer, ToolCatalogItem } from "@testforge/contracts/devices";
import { MonitorIcon, PlusIcon, ServerIcon, WrenchIcon } from "lucide-react";
import { PropRow } from "../../../shared/layout.js";
import { TooltipIconButton } from "../../../shared/ui/checkbox";
import { ComputerActions, ServerActions } from "./DeviceActions.js";
import { connectionDot, mcpRowStatuses, stateLabel } from "./device-labels.js";
import { InlineDetail, TreeRow } from "./TreeRow.js";

/** Remote computer → MCP Server → tool tree. */
export function RemoteComputerTree({ data, selected, isOpen, onSelect, onToggle, onAddComputer, onEditComputer, onAddServer, onEditServer, onChanged }: {
  data: DashboardSnapshot;
  selected: string | null;
  isOpen: (key: string) => boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
  onAddComputer: () => void;
  onEditComputer: (computer: RemoteComputer) => void;
  onAddServer: (computerId: string) => void;
  onEditServer: (server: McpServerConfig) => void;
  onChanged: () => Promise<void>;
}) {
  const rootOpen = isOpen("remotes");
  return <div className="min-w-0 overflow-hidden rounded-md border bg-background" role="tree" aria-label="远程电脑列表">
    <div>
      <TreeRow
        className="h-9 bg-secondary/60 font-semibold"
        depth={0}
        icon={<MonitorIcon className="size-4" />}
        label="远程电脑列表"
        title="仪器控制电脑及其 MCP Server"
        hasChildren
        open={rootOpen}
        selected={selected === "remotes"}
        onClick={() => { onSelect("remotes"); onToggle("remotes"); }}
        actions={<span className="flex flex-none items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
          <TooltipIconButton tooltip="添加电脑" aria-label="添加电脑" onClick={(event) => { event.stopPropagation(); onAddComputer(); }}><PlusIcon /></TooltipIconButton>
        </span>}
      />
      {rootOpen && data.computers.map((computer) => {
        const key = `c:${computer.id}`;
        const open = isOpen(key);
        const servers = data.servers.filter((item) => item.computerId === computer.id);
        const status = data.statuses.find((item) => item.computerId === computer.id);
        const sshOnline = status?.ssh.state === "online";
        return <div key={key}>
          <TreeRow
            depth={1}
            icon={<MonitorIcon className="size-4" />}
            label={computer.label}
            title={`${computer.id} · ${computer.address}`}
            statuses={[{ dot: connectionDot(status?.ssh.state ?? "unknown"), label: `SSH ${stateLabel(status?.ssh.state ?? "unknown")}`, title: status?.ssh.message }]}
            hasChildren
            open={open}
            selected={selected === key}
            onClick={() => { onSelect(key); onToggle(key); }}
            actions={<ComputerActions computer={computer} onEdit={() => onEditComputer(computer)} onAddServer={() => onAddServer(computer.id)} onChanged={onChanged} />}
          />
          {open && servers.map((server) => {
            const serverKey = `s:${server.serverId}`;
            const serverOpen = isOpen(serverKey);
            const serverStatus = data.serverStatuses.find((item) => item.serverId === server.serverId);
            const occupancy = data.occupancy.find((item) => item.hardwareId === server.hardwareId);
            const executing = data.execution.state !== "idle" && (
              data.execution.state === "manual" ? data.execution.hardwareId === server.hardwareId : data.execution.hardwareIds.includes(server.hardwareId)
            );
            const tools = data.tools.filter((tool) => tool.serverId === server.serverId);
            return <div key={serverKey}>
              <TreeRow
                depth={2}
                icon={<ServerIcon className="size-4" />}
                label={server.label}
                title={`${server.serverId} · ${server.hardwareId} · ${server.url}`}
                statuses={[...mcpRowStatuses(serverStatus), occupancyRowStatus(occupancy)]}
                hasChildren
                open={serverOpen}
                selected={selected === serverKey}
                onClick={() => { onSelect(serverKey); onToggle(serverKey); }}
                actions={<ServerActions server={server} status={serverStatus} occupancy={occupancy} hardwareExecuting={executing} sshOnline={sshOnline} onEdit={() => onEditServer(server)} onChanged={onChanged} />}
              />
              {serverOpen && tools.map((tool) => {
                const toolKey = `t:${tool.externalName}`;
                return <div key={toolKey}>
                  <TreeRow depth={3} icon={<WrenchIcon className="size-3.5" />} label={tool.externalName} title={tool.description} hasChildren open={isOpen(toolKey)} selected={selected === toolKey} onClick={() => { onSelect(toolKey); onToggle(toolKey); }} />
                  {isOpen(toolKey) && <InlineDetail depth={3}><ToolInline tool={tool} /></InlineDetail>}
                </div>;
              })}
              {serverOpen && tools.length === 0 && <InlineDetail depth={3}><p className="m-0 text-xs text-muted-foreground">MCP 在线后会列出该 Server 暴露的工具。</p></InlineDetail>}
            </div>;
          })}
          {open && servers.length === 0 && <InlineDetail depth={2}><p className="m-0 text-xs text-muted-foreground">还没有 MCP Server。点右侧“添加 MCP Server”为每个受管硬件注册一个独立进程。</p></InlineDetail>}
        </div>;
      })}
      {rootOpen && data.computers.length === 0 && <InlineDetail depth={1}><p className="m-0 text-xs text-muted-foreground">还没有远程电脑。点右侧“+”添加仪器控制电脑。</p></InlineDetail>}
    </div>
  </div>;
}

function occupancyRowStatus(status: DashboardSnapshot["occupancy"][number] | undefined) {
  if (status?.state === "occupied_by_self") return { dot: "ok", label: "已占用", title: "由当前 TestForge 客户端占用" };
  if (status?.state === "occupied_elsewhere") return { dot: "warn", label: "他人占用", title: status.holderLabel ?? "由其他 TestForge 客户端占用" };
  if (status?.state === "unoccupied") return { dot: "muted", label: "未占用", title: "点击锁按钮占用后才可操作硬件" };
  return { dot: "muted", label: "占用未知", title: status?.message ?? "尚未读取硬件占用状态" };
}

function ToolInline({ tool }: { tool: ToolCatalogItem }) {
  return <>
    <div className="mb-3 overflow-hidden rounded-md border bg-background">
      <PropRow label="远程名称"><code>{tool.remoteName}</code></PropRow>
      <PropRow label="来源"><code>{tool.serverId}</code></PropRow>
      <PropRow label="类型">{tool.kind}</PropRow>
      {tool.description && <PropRow label="描述">{tool.description}</PropRow>}
    </div>
    <pre className="m-0 max-h-80 overflow-auto rounded-md border bg-secondary/50 px-4 py-3.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
  </>;
}
