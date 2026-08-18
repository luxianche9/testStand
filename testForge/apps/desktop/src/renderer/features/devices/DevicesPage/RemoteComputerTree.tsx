import type { DashboardSnapshot } from "@testforge/contracts/desktop";
import type { McpServerConfig, RemoteComputer, ToolCatalogItem } from "@testforge/contracts/devices";
import { IconDesktop, IconMcp, IconPlus, IconServer } from "../../../shared/icons.js";
import { PropRow } from "../../../shared/layout.js";
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
  return <div className="page-tree" role="tree" aria-label="远程电脑列表">
    <div className="tree-node">
      <TreeRow
        className="section-row"
        depth={0}
        icon={<IconDesktop size={16} />}
        label="远程电脑列表"
        title="仪器控制电脑及其 MCP Server"
        hasChildren
        open={rootOpen}
        selected={selected === "remotes"}
        onClick={() => { onSelect("remotes"); onToggle("remotes"); }}
        actions={<span className="row-actions" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="row-action accent" title="添加电脑" aria-label="添加电脑" onClick={(event) => { event.stopPropagation(); onAddComputer(); }}><IconPlus size={14} /></button>
        </span>}
      />
      {rootOpen && data.computers.map((computer) => {
        const key = `c:${computer.id}`;
        const open = isOpen(key);
        const servers = data.servers.filter((item) => item.computerId === computer.id);
        const status = data.statuses.find((item) => item.computerId === computer.id);
        const sshOnline = status?.ssh.state === "online";
        return <div className="tree-node" key={key}>
          <TreeRow
            className="computer-row"
            depth={1}
            icon={<IconDesktop size={15} />}
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
            const tools = data.tools.filter((tool) => tool.serverId === server.serverId);
            return <div className="tree-node" key={serverKey}>
              <TreeRow
                className="server-row hardware-row"
                depth={2}
                icon={<IconServer size={15} />}
                label={server.label}
                title={`${server.serverId} · ${server.hardwareId} · ${server.url}`}
                statuses={mcpRowStatuses(serverStatus)}
                hasChildren
                open={serverOpen}
                selected={selected === serverKey}
                onClick={() => { onSelect(serverKey); onToggle(serverKey); }}
                actions={<ServerActions server={server} status={serverStatus} sshOnline={sshOnline} onEdit={() => onEditServer(server)} onChanged={onChanged} />}
              />
              {serverOpen && tools.map((tool) => {
                const toolKey = `t:${tool.externalName}`;
                return <div className="tree-node" key={toolKey}>
                  <TreeRow className="tool-row" depth={3} icon={<IconMcp size={14} />} label={tool.externalName} title={tool.description} hasChildren open={isOpen(toolKey)} selected={selected === toolKey} onClick={() => { onSelect(toolKey); onToggle(toolKey); }} />
                  {isOpen(toolKey) && <InlineDetail depth={3}><ToolInline tool={tool} /></InlineDetail>}
                </div>;
              })}
              {serverOpen && tools.length === 0 && <InlineDetail depth={3}><p className="muted-copy">MCP 在线后会列出该 Server 暴露的工具。</p></InlineDetail>}
            </div>;
          })}
          {open && servers.length === 0 && <InlineDetail depth={2}><p className="muted-copy">还没有 MCP Server。点右侧“添加 MCP Server”为每个受管硬件注册一个独立进程。</p></InlineDetail>}
        </div>;
      })}
      {rootOpen && data.computers.length === 0 && <InlineDetail depth={1}><p className="muted-copy">还没有远程电脑。点右侧“+”添加仪器控制电脑。</p></InlineDetail>}
    </div>
  </div>;
}

function ToolInline({ tool }: { tool: ToolCatalogItem }) {
  return <>
    <div className="props">
      <PropRow label="远程名称"><code>{tool.remoteName}</code></PropRow>
      <PropRow label="来源"><code>{tool.serverId}</code></PropRow>
      <PropRow label="类型">{tool.kind}</PropRow>
      {tool.description && <PropRow label="描述">{tool.description}</PropRow>}
    </div>
    <pre className="code-block schema">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
  </>;
}
