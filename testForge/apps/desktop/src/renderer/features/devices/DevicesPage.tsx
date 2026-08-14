import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { DashboardSnapshot } from "@testforge/contracts/desktop";
import type {
  DeviceBundleKind, Hardware, HardwarePort, McpServerConfig, RemoteComputer, ServerStatus, ToolCatalogItem
} from "@testforge/contracts/devices";
import {
  IconAlert, IconChevron, IconChip, IconCopy, IconDesktop, IconDownload, IconEdit, IconMcp, IconPlay, IconPlus,
  IconRefresh, IconServer, IconStop, IconTrash
} from "../../shared/icons.js";
import { Badge, Btn, Dot, EmptyState, Modal, Spinner } from "../../shared/ui.js";
import { hardwareForServer } from "../../shared/hardware.js";
import { PageHeader, PropRow, QueryGate } from "../../shared/layout.js";
import { AppearanceImage, PortEditor } from "./PortEditor.js";
import { useDeviceCatalog } from "../../shared/queries.js";

/* ------------------------------- 设备管理页 ------------------------------- */

export function DevicesPage({ query }: { query: UseQueryResult<DashboardSnapshot> }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [computerEditor, setComputerEditor] = useState<{ open: boolean; computer?: RemoteComputer }>({ open: false });
  const [serverEditor, setServerEditor] = useState<{ open: boolean; server?: McpServerConfig; computerId?: string }>({ open: false });
  const [hardwareEditor, setHardwareEditor] = useState<{ open: boolean; hardware?: Hardware }>({ open: false });
  const catalog = useDeviceCatalog();
  const refreshAll = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["dashboard"] }), client.invalidateQueries({ queryKey: ["device-catalog"] })]);
  };
  const refreshHardware = useMutation({
    mutationFn: () => window.testforge.devices.refreshManagedHardware(),
    onSettled: () => void refreshAll()
  });

  // 任一 Server 的 MCP 变为在线后自动发现硬件，无需手动点刷新
  const refreshHardwareRef = useRef(refreshHardware.mutate);
  refreshHardwareRef.current = refreshHardware.mutate;
  const mcpOnlineRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const statuses = query.data?.serverStatuses;
    if (!statuses) return;
    const nowOnline = new Set(statuses.filter((item) => item.mcp.state === "online").map((item) => item.serverId));
    const becameOnline = [...nowOnline].filter((id) => !mcpOnlineRef.current.has(id));
    mcpOnlineRef.current = nowOnline;
    if (becameOnline.length > 0) refreshHardwareRef.current();
  }, [query.data?.serverStatuses]);

  // 一键检测全部电脑 SSH 与全部 MCP Server；单项失败不影响其余
  const probeStatuses = useMutation({
    mutationFn: async () => {
      const snapshot = query.data;
      if (!snapshot) return;
      await Promise.allSettled([
        ...snapshot.computers.map((computer) => window.testforge.devices.refreshComputer(computer.id)),
        ...snapshot.servers.map((server) => window.testforge.devices.refreshServer(server.serverId))
      ]);
      try { await window.testforge.devices.refreshManagedHardware(); } catch { /* 部分 MCP 离线时硬件枚举可能失败，状态已在上面写回 */ }
    },
    onSettled: () => void refreshAll()
  });

  // 分区根与电脑/Server 默认展开；工具节点默认折叠
  const isOpen = (key: string) => expanded[key] ?? !key.startsWith("t:");
  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !(current[key] ?? !key.startsWith("t:")) }));

  const data = query.data;
  const hardware = catalog.data?.hardware ?? [];
  const effectiveSelected = selected ?? (data?.computers[0] ? `c:${data.computers[0].id}` : null);

  return (
    <main className="page">
      <div className="page-inner">
        <PageHeader
          title="设备管理"
          actions={
            <Btn
              icon={<IconRefresh size={14} className={probeStatuses.isPending ? "spin" : undefined} />}
              onClick={() => probeStatuses.mutate()}
              disabled={probeStatuses.isPending || !data}
            >
              状态检测
            </Btn>
          }
        />
        <QueryGate query={query}>
          {(snapshot) => (
            <div className="device-trees">
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
            </div>
          )}
        </QueryGate>
      </div>
      <ComputerEditor
        open={computerEditor.open}
        computer={computerEditor.computer}
        onClose={() => setComputerEditor({ open: false })}
        onChanged={refreshAll}
      />
      <ServerEditor
        open={serverEditor.open}
        server={serverEditor.server}
        computerId={serverEditor.computerId}
        computers={data?.computers ?? []}
        hardware={hardware}
        onClose={() => setServerEditor({ open: false })}
        onChanged={refreshAll}
      />
      <HardwareEditor
        open={hardwareEditor.open}
        hardware={hardwareEditor.hardware}
        onClose={() => setHardwareEditor({ open: false })}
        onChanged={refreshAll}
      />
    </main>
  );
}

/** 远程电脑 → MCP Server → 工具，与硬件列表分开展示。 */
function RemoteComputerTree({ data, selected, isOpen, onSelect, onToggle, onAddComputer, onEditComputer, onAddServer, onEditServer, onChanged }: {
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
  return (
    <div className="page-tree" role="tree" aria-label="远程电脑列表">
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
          actions={
            <span className="row-actions" onClick={(event) => event.stopPropagation()}>
              <button type="button" className="row-action accent" title="添加电脑" aria-label="添加电脑" onClick={(event) => { event.stopPropagation(); onAddComputer(); }}>
                <IconPlus size={14} />
              </button>
            </span>
          }
        />
        {rootOpen && data.computers.map((computer) => {
          const key = `c:${computer.id}`;
          const open = isOpen(key);
          const servers = data.servers.filter((item) => item.computerId === computer.id);
          const status = data.statuses.find((item) => item.computerId === computer.id);
          const sshOnline = status?.ssh.state === "online";
          return (
            <div className="tree-node" key={key}>
              <TreeRow
                className="computer-row"
                depth={1}
                icon={<IconDesktop size={15} />}
                label={computer.label}
                title={`${computer.id} · ${computer.address}`}
                statuses={[
                  { dot: connDot(status?.ssh.state ?? "unknown"), label: `SSH ${stateLabel(status?.ssh.state ?? "unknown")}`, title: status?.ssh.message }
                ]}
                hasChildren
                open={open}
                selected={selected === key}
                onClick={() => { onSelect(key); onToggle(key); }}
                actions={<ComputerActions computer={computer} onEdit={() => onEditComputer(computer)} onAddServer={() => onAddServer(computer.id)} onChanged={onChanged} />}
              />
              {open && servers.map((server) => {
                const sKey = `s:${server.serverId}`;
                const sOpen = isOpen(sKey);
                const serverStatus = data.serverStatuses.find((item) => item.serverId === server.serverId);
                const tools = data.tools.filter((tool) => tool.serverId === server.serverId);
                return (
                  <div className="tree-node" key={sKey}>
                    <TreeRow
                      className="server-row hardware-row"
                      depth={2}
                      icon={<IconServer size={15} />}
                      label={server.label}
                      title={`${server.serverId} · ${server.hardwareId} · ${server.url}`}
                      statuses={mcpRowStatuses(serverStatus)}
                      hasChildren
                      open={sOpen}
                      selected={selected === sKey}
                      onClick={() => { onSelect(sKey); onToggle(sKey); }}
                      actions={
                        <ServerActions
                          server={server}
                          status={serverStatus}
                          sshOnline={sshOnline}
                          onEdit={() => onEditServer(server)}
                          onChanged={onChanged}
                        />
                      }
                    />
                    {sOpen && tools.map((tool) => {
                      const tKey = `t:${tool.externalName}`;
                      return (
                        <div className="tree-node" key={tKey}>
                          <TreeRow
                            className="tool-row"
                            depth={3}
                            icon={<IconMcp size={14} />}
                            label={tool.externalName}
                            title={tool.description}
                            hasChildren
                            open={isOpen(tKey)}
                            selected={false}
                            onClick={() => onToggle(tKey)}
                          />
                          {isOpen(tKey) && (
                            <InlineDetail depth={3}>
                              <ToolInline tool={tool} />
                            </InlineDetail>
                          )}
                        </div>
                      );
                    })}
                    {sOpen && tools.length === 0 && (
                      <InlineDetail depth={3}><p className="muted-copy">MCP 在线后会列出该 Server 暴露的工具。</p></InlineDetail>
                    )}
                  </div>
                );
              })}
              {open && servers.length === 0 && (
                <InlineDetail depth={2}><p className="muted-copy">还没有 MCP Server。点右侧「添加 MCP Server」为每个受管硬件注册一个独立进程。</p></InlineDetail>
              )}
            </div>
          );
        })}
        {rootOpen && data.computers.length === 0 && (
          <InlineDetail depth={1}>
            <p className="muted-copy">还没有远程电脑。点右侧「+」添加仪器控制电脑。</p>
          </InlineDetail>
        )}
      </div>
    </div>
  );
}

/** 被动 硬件独立一棵树，与远程电脑列表左对齐。 */
function HardwareListTree({ hardware, selected, isOpen, onSelect, onToggle, onAddHardware, onEditHardware, onChanged }: {
  hardware: Hardware[];
  selected: string | null;
  isOpen: (key: string) => boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
  onAddHardware: () => void;
  onEditHardware: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
}) {
  const passive = hardware.filter((item) => item.kind === "passive");
  const rootOpen = isOpen("hardware");
  return (
    <div className="page-tree" role="tree" aria-label="硬件列表">
      <div className="tree-node">
        <TreeRow
          className="section-row"
          depth={0}
          icon={<IconChip size={16} />}
          label="硬件列表"
          title="被测对象、夹具等不由 MCP Server 控制的硬件"
          hasChildren
          open={rootOpen}
          selected={selected === "hardware"}
          onClick={() => { onSelect("hardware"); onToggle("hardware"); }}
          actions={
            <span className="row-actions" onClick={(event) => event.stopPropagation()}>
              <button type="button" className="row-action accent" title="添加被动 硬件" aria-label="添加被动 硬件" onClick={(event) => { event.stopPropagation(); onAddHardware(); }}>
                <IconPlus size={14} />
              </button>
            </span>
          }
        />
        {rootOpen && passive.map((item) => (
          <div className="tree-node" key={`l:${item.hardwareId}`}>
            <TreeRow
              className="server-row hardware-row"
              depth={1}
              icon={<IconChip size={15} />}
              label={item.label}
              title={item.hardwareId}
              selected={selected === `l:${item.hardwareId}`}
              onClick={() => onSelect(`l:${item.hardwareId}`)}
              actions={<HardwareActions hardware={item} onEdit={onEditHardware} onChanged={onChanged} />}
            />
          </div>
        ))}
        {rootOpen && passive.length === 0 && (
          <InlineDetail depth={1}><p className="muted-copy">还没有被动 硬件。被测对象和夹具在这里登记后才能进入接线画布。</p></InlineDetail>
        )}
      </div>
    </div>
  );
}

function TreeRow({ depth, icon, label, subtitle, title, meta, statuses, hasChildren, open, selected, onClick, actions, className = "" }: {
  depth: number;
  icon: ReactNode;
  label: string;
  subtitle?: string | undefined;
  title?: string | undefined;
  meta?: string | undefined;
  statuses?: { dot: string; label: string; title?: string | undefined }[];
  hasChildren?: boolean;
  open?: boolean;
  selected: boolean;
  onClick: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      tabIndex={0}
      aria-selected={selected}
      aria-expanded={hasChildren ? Boolean(open) : undefined}
      className={`tree-row${selected ? " selected" : ""}${className ? ` ${className}` : ""}`}
      style={{ paddingLeft: 12 + depth * 20 }}
      title={title ?? label}
      onClick={onClick}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}
    >
      <span className={`twisty${open ? " open" : ""}`}>{hasChildren ? <IconChevron size={13} /> : null}</span>
      <span className="tree-icon">{icon}</span>
      <span className="tree-label">{label}</span>
      {subtitle && <span className="tree-subtitle">{subtitle}</span>}
      {meta && <span className="tree-count">{meta}</span>}
      {statuses?.map((status) => (
        <span key={status.label} className="row-status-item" title={status.title}>
          <Dot state={status.dot} />
          <span className={`row-status s-${status.dot}`}>{status.label}</span>
        </span>
      ))}
      {actions}
    </div>
  );
}

function InlineDetail({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className="inline-detail">
      <div className="inline-clip">
        <div className="inline-body" style={{ marginLeft: 12 + depth * 20 }}>{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------- 内联详情 ------------------------------- */

function ComputerActions({ computer, onEdit, onAddServer, onChanged }: {
  computer: RemoteComputer;
  onEdit: () => void;
  onAddServer: () => void;
  onChanged: () => Promise<void>;
}) {
  const remove = useMutation({
    mutationFn: () => window.testforge.devices.removeComputer(computer.id),
    onSettled: () => void onChanged()
  });
  const open = (handler: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); handler(); };
  return (
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="row-action" title="编辑 SSH 信息" aria-label="编辑 SSH 信息" onClick={open(onEdit)}>
        <IconEdit size={14} />
      </button>
      <button type="button" className="row-action accent" title="添加 MCP 服务器" aria-label="添加 MCP 服务器" onClick={open(onAddServer)}>
        <IconPlus size={14} />
      </button>
      <button
        type="button"
        className="row-action"
        title="删除远程电脑及其全部 MCP Server（远程文件不会被删除）"
        aria-label="删除远程电脑"
        onClick={(event) => { event.stopPropagation(); if (confirm(`删除 ${computer.label}？其下所有 MCP Server 配置会一并删除，远程文件不受影响。`)) remove.mutate(); }}
        disabled={remove.isPending}
      >
        <IconTrash size={14} />
      </button>
      {remove.isError && <span className="row-error" title={String(remove.error)}><IconAlert size={14} /></span>}
    </span>
  );
}

function ServerActions({ server, status, sshOnline, onEdit, onChanged }: {
  server: McpServerConfig;
  status?: ServerStatus | undefined;
  sshOnline: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const [stopFailed, setStopFailed] = useState(false);
  const action = useMutation({
    mutationFn: async (kind: "start" | "stop" | "force-stop" | "remove") => {
      if (kind === "remove") return window.testforge.devices.removeServer(server.serverId);
      return window.testforge.devices.serverAction(server.serverId, kind);
    },
    onSuccess: (_result, kind) => { if (kind === "stop" || kind === "force-stop") setStopFailed(false); },
    onError: (_error, kind) => { if (kind === "stop") setStopFailed(true); },
    onSettled: () => { void onChanged(); }
  });
  const fire = (kind: "start" | "stop" | "force-stop") => (event: React.MouseEvent) => {
    event.stopPropagation();
    action.mutate(kind);
  };
  const open = (handler: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); handler(); };
  // 进程操作经由所属电脑的 SSH 通道执行
  const gateTitle = (label: string) => (sshOnline ? label : "所属电脑 SSH 在线后才能操作");
  return (
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="row-action accent" title={gateTitle("启动 MCP 服务")} aria-label="启动 MCP 服务" onClick={fire("start")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "Running"}>
        <IconPlay size={13} />
      </button>
      <button type="button" className="row-action" title={gateTitle("终止 MCP 服务")} aria-label="终止 MCP 服务" onClick={fire("stop")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "Stopped"}>
        <IconStop size={13} />
      </button>
      {stopFailed && (
        <button type="button" className="row-action danger" title="安全停止失败，强制结束进程" aria-label="强制终止 MCP 服务" onClick={fire("force-stop")} disabled={action.isPending}>
          <IconAlert size={14} />
        </button>
      )}
      <button type="button" className="row-action" title="编辑信息" aria-label="编辑信息" onClick={open(onEdit)}>
        <IconEdit size={14} />
      </button>
      <button
        type="button"
        className="row-action"
        title="删除该 MCP Server（不会删除远程文件）"
        aria-label="删除 MCP Server"
        onClick={(event) => { event.stopPropagation(); if (confirm(`删除 ${server.serverId}？远程文件不会被删除。`)) action.mutate("remove"); }}
        disabled={action.isPending}
      >
        <IconTrash size={14} />
      </button>
      {action.isError && <span className="row-error" title={String(action.error)}><IconAlert size={14} /></span>}
    </span>
  );
}

function HardwareActions({ hardware, onEdit, onChanged }: {
  hardware: Hardware;
  onEdit: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
}) {
  const remove = useMutation({
    mutationFn: () => window.testforge.devices.removeHardware(hardware.hardwareId),
    onSettled: () => void onChanged()
  });
  return (
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="row-action" title="编辑" aria-label="编辑" onClick={(event) => { event.stopPropagation(); onEdit(hardware); }}>
        <IconEdit size={14} />
      </button>
      <button
        type="button"
        className="row-action"
        title="移除该硬件"
        aria-label="移除硬件"
        onClick={(event) => { event.stopPropagation(); if (confirm(`移除 ${hardware.label}？端口、针脚和照片会一并删除，画布上引用它的节点会显示为未解析。`)) remove.mutate(); }}
        disabled={remove.isPending}
      >
        <IconTrash size={14} />
      </button>
      {remove.isError && <span className="row-error" title={String(remove.error)}><IconAlert size={14} /></span>}
    </span>
  );
}

function ToolInline({ tool }: { tool: ToolCatalogItem }) {
  return (
    <>
      <div className="props">
        <PropRow label="远程名称"><code>{tool.remoteName}</code></PropRow>
        <PropRow label="来源"><code>{tool.serverId}</code></PropRow>
        <PropRow label="类型">{tool.kind}</PropRow>
        {tool.description && <PropRow label="描述">{tool.description}</PropRow>}
      </div>
      <pre className="code-block schema">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
    </>
  );
}

/* --------------------------------- 对话框 -------------------------------- */

function Field({ label, required, span, children }: { label: string; required?: boolean; span?: boolean; children: ReactNode }) {
  return (
    <label className={`field${span ? " span-2" : ""}`}>
      <span className="field-label">{label}{required && <i>*</i>}</span>
      {children}
    </label>
  );
}

/**
 * Hardware travels as one canonical `.tfhw` containing its ports and photos. Remote computers,
 * Servers and credentials are installation-global records and are never bundled.
 */
function BundleActions({ kind, id, saved, onChanged }: {
  kind: DeviceBundleKind;
  id: string;
  saved: boolean;
  onChanged: (importedId: string) => Promise<void>;
}) {
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const act = useMutation({
    mutationFn: async (action: "export" | "import") =>
      action === "export" ? await window.testforge.devices.exportBundle(kind, id) : await window.testforge.devices.importBundle(kind),
    onSuccess: async (result) => {
      setError(undefined);
      if (!result) return;
      if ("path" in result) { setNotice(`已导出到 ${result.path}`); return; }
      setNotice(`已${result.replaced ? "覆盖" : "导入"} ${result.label}`);
      await onChanged(result.id);
    },
    onError: (value) => { setNotice(undefined); setError(String(value)); }
  });
  return (
    <div className="bundle-actions">
      <Btn variant="subtle" icon={<IconDownload size={14} />} disabled={act.isPending} onClick={() => act.mutate("import")}>导入…</Btn>
      <Btn
        variant="subtle"
        icon={<IconCopy size={14} />}
        disabled={!saved || act.isPending}
        title={saved ? "导出为单个 .tfhw 文件" : "保存后才能导出"}
        onClick={() => act.mutate("export")}
      >导出…</Btn>
      {notice && <span className="library-notice" role="status">{notice}</span>}
      {error && <span className="library-notice error" role="alert" title={error}><IconAlert size={14} />{error}</span>}
    </div>
  );
}

function ComputerEditor({ open, computer, onClose, onChanged }: {
  open: boolean;
  computer?: RemoteComputer | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const blank = { id: "REMOTE_PC_1", label: "仪器控制电脑", address: "", sshPort: "22", username: "", sshSecret: "" };
  const [form, setForm] = useState(blank);
  useEffect(() => {
    if (!open) return;
    setForm(computer
      ? {
          id: computer.id, label: computer.label, address: computer.address, sshPort: String(computer.ssh.port),
          username: computer.ssh.username, sshSecret: ""
        }
      : blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, computer]);

  const save = useMutation({
    mutationFn: async () => {
      const input: RemoteComputer = {
        id: form.id.trim(), label: form.label.trim(), address: form.address.trim(),
        ssh: { port: Number(form.sshPort), username: form.username.trim() }
      };
      return window.testforge.devices.saveComputer(input, form.sshSecret ? { ssh: form.sshSecret } : undefined);
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });

  const field = (key: keyof typeof form) => ({
    value: String(form[key]),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={computer ? "编辑远程电脑" : "添加远程电脑"}
      width={640}
      footer={<>
        <Btn onClick={onClose}>取消</Btn>
        <Btn variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !form.address || !form.username}>
          {save.isPending ? "保存中…" : "保存"}
        </Btn>
      </>}
    >
      <div className="form-grid">
        <Field label="电脑 ID" required><input className="input" {...field("id")} disabled={Boolean(computer)} /></Field>
        <Field label="显示名称" required><input className="input" {...field("label")} /></Field>
        <Field label="IP 地址 / 主机名" required><input className="input" {...field("address")} placeholder="192.168.3.51" /></Field>
        <Field label="SSH 端口" required><input className="input" type="number" {...field("sshPort")} /></Field>
        <Field label="SSH 用户名" required><input className="input" {...field("username")} /></Field>
        <Field label={computer ? "SSH 密码（留空保持不变）" : "SSH 密码"}><input className="input" type="password" {...field("sshSecret")} /></Field>
        <div className="span-2 form-note">MCP Server 在电脑保存后逐个添加，每个硬件对应一个独立 Server。</div>
        {save.isError && <div className="alert span-2"><IconAlert size={15} /><span>{String(save.error)}</span></div>}
      </div>
    </Modal>
  );
}

/** Rendering a server bundle creates E:\<hardware_name>_mcp_server\ with these scripts. */
function serverDefaults(serverId: string) {
  const hardwareName = serverId.replace(/_MCP$/, "").toLowerCase();
  const root = `E:\\${hardwareName}_mcp_server`;
  return {
    statusCommand: `& '${root}\\status.ps1'`,
    startCommand: `& '${root}\\start.ps1'`,
    stopCommand: `& '${root}\\stop.ps1'`,
    logPath: `${root}\\logs`
  };
}

/**
 * A Server and the one device it drives are edited together: the Server holds the connection and
 * lifecycle commands, the device holds the ports, pins and photos. Nothing here asks the remote
 * what its pins are, so a card can be fully described while its PC is switched off.
 */
function ServerEditor({ open, server, computerId, computers, hardware, onClose, onChanged }: {
  open: boolean;
  server?: McpServerConfig | undefined;
  computerId?: string | undefined;
  computers: RemoteComputer[];
  hardware: Hardware[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const blank = {
    serverId: "", computerId: computerId ?? computers[0]?.id ?? "", label: "", hardwareId: "", url: "", mcpToken: "",
    ...serverDefaults("")
  };
  const [form, setForm] = useState(blank);
  const [ports, setPorts] = useState<HardwarePort[]>([]);
  const [pathsTouched, setPathsTouched] = useState(false);

  const live = server ? hardwareForServer(server, hardware) : undefined;
  const selectedHardware = live ?? hardware.find((item) => item.hardwareId === form.hardwareId);
  useEffect(() => {
    if (!open) return;
    setPathsTouched(Boolean(server));
    setForm(server
      ? { serverId: server.serverId, computerId: server.computerId, label: server.label, hardwareId: server.hardwareId, url: server.url, mcpToken: "", ...server.lifecycle }
      : { ...blank, computerId: computerId ?? computers[0]?.id ?? "" });
    setPorts(live ? structuredClone(live.ports) : []);
    // Only reseed on open or when switching Server: an image upload refreshes `live` and must not
    // discard ports the user is midway through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.serverId, computerId]);

  const save = useMutation({
    mutationFn: async () => {
      const host = computers.find((item) => item.id === form.computerId)?.address ?? "";
      const hardwareId = form.hardwareId.trim();
      const input: McpServerConfig = {
        serverId: form.serverId.trim(), computerId: form.computerId, label: form.label.trim() || form.serverId.trim(),
        hardwareId,
        url: form.url.trim() || `http://${host}:8011/mcp`,
        enabled: true,
        lifecycle: { statusCommand: form.statusCommand.trim(), startCommand: form.startCommand.trim(), stopCommand: form.stopCommand.trim(), logPath: form.logPath.trim() }
      };
      const saved = await window.testforge.devices.saveServer(input, form.mcpToken ? { mcpToken: form.mcpToken } : undefined);
      // The Server row and its managed device are one thing to the user, so both are written here.
      await window.testforge.devices.saveHardware({
        formatVersion: 2, hardwareId, label: input.label, kind: "managed",
        serverId: input.serverId, computerId: input.computerId, ports,
        ...(selectedHardware?.appearanceAssetId ? { appearanceAssetId: selectedHardware.appearanceAssetId } : {})
      });
      return saved;
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });

  const field = (key: keyof typeof form) => ({
    value: String(form[key]),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  });
  // 新建时 serverId 决定默认部署路径；一旦手工改过路径就不再覆盖
  const pathField = (key: "statusCommand" | "startCommand" | "stopCommand" | "logPath") => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setPathsTouched(true); setForm((current) => ({ ...current, [key]: event.target.value })); }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={server ? "编辑 MCP Server" : "添加 MCP Server"}
      width={760}
      footer={<>
        <Btn onClick={onClose}>取消</Btn>
        <Btn variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !form.serverId || !form.computerId || !form.hardwareId}>
          {save.isPending ? "保存中…" : "保存"}
        </Btn>
      </>}
    >
      <div className="form-grid">
        <Field label="Server ID" required>
          <input
            className="input"
            value={form.serverId}
            disabled={Boolean(server)}
            onChange={(event) => {
              const serverId = event.target.value;
              setForm((current) => ({ ...current, serverId, ...(pathsTouched ? {} : serverDefaults(serverId)) }));
            }}
            placeholder="PCI1710L_MCP"
          />
        </Field>
        <Field label="所属电脑" required>
          <select className="input" {...field("computerId")} disabled={Boolean(server)}>
            {computers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </Field>
        <Field label="显示名称"><input className="input" {...field("label")} placeholder="PCI-1710L 多功能采集卡" /></Field>
        <Field label="唯一 Hardware ID" required>
          <input className="input" list="testforge-hardware-ids" value={form.hardwareId} disabled={Boolean(server)} placeholder="PC1_MCP.PCI1710L_CARD_0" onChange={(event) => {
            const hardwareId = event.target.value;
            const selected = hardware.find((item) => item.hardwareId === hardwareId);
            setForm((current) => ({ ...current, hardwareId }));
            if (selected) setPorts(structuredClone(selected.ports));
          }} />
          <datalist id="testforge-hardware-ids">{hardware.filter((item) => item.kind === "passive" || item.serverId === server?.serverId).map((item) => <option key={item.hardwareId} value={item.hardwareId}>{item.label}</option>)}</datalist>
        </Field>
        <Field label="MCP 地址"><input className="input" {...field("url")} placeholder="http://192.168.3.51:8011/mcp" /></Field>
        <Field label={server ? "MCP Token（留空保持不变）" : "MCP Token"}><input className="input" type="password" {...field("mcpToken")} /></Field>
        <div className="span-2 form-note">TestForge 会验证该 Server 的 list_hardware 恰好返回这一块硬件；端口和针脚不再向远端索取，全部在下方登记。</div>
        <Field label="状态查询命令" required span><textarea className="input" {...pathField("statusCommand")} /></Field>
        <Field label="启动命令" required span><textarea className="input" {...pathField("startCommand")} /></Field>
        <Field label="停止命令" required span><textarea className="input" {...pathField("stopCommand")} /></Field>
        <Field label="日志目录" required span><input className="input" {...pathField("logPath")} /></Field>

        <div className="span-2 editor-assets">
          <AppearanceImage
            hardwareId={form.hardwareId}
            assetId={selectedHardware?.appearanceAssetId}
            saved={Boolean(selectedHardware)}
            onChanged={(item) => setPorts(structuredClone(item.ports))}
          />
          <PortEditor
            hardwareId={form.hardwareId}
            ports={ports}
            saved={Boolean(selectedHardware)}
            onChange={setPorts}
            onImageChanged={(item) => setPorts(structuredClone(item.ports))}
          />
        </div>

        {save.isError && <div className="alert span-2"><IconAlert size={15} /><span>{String(save.error)}</span></div>}
      </div>
    </Modal>
  );
}

/** DUTs, fixtures and breakout boards: no MCP Server, no lease, just ports and photos. */
function HardwareEditor({ open, hardware, onClose, onChanged }: {
  open: boolean;
  hardware?: Hardware | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const catalog = useDeviceCatalog();
  const [form, setForm] = useState({ hardwareId: "DUT_1", label: "被测对象" });
  const [ports, setPorts] = useState<HardwarePort[]>([]);

  // Uploads write straight to disk, so the freshest copy of this record is the one in the catalog.
  const live = hardware ? (catalog.data?.hardware.find((item) => item.hardwareId === hardware.hardwareId) ?? hardware) : undefined;

  useEffect(() => {
    if (!open) return;
    setForm(hardware ? { hardwareId: hardware.hardwareId, label: hardware.label } : { hardwareId: "DUT_1", label: "被测对象" });
    setPorts(hardware ? structuredClone(hardware.ports) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hardware?.hardwareId]);

  const save = useMutation({
    mutationFn: async () => {
      const hardwareId = form.hardwareId.trim();
      if (!hardwareId || /\s/.test(hardwareId)) throw new Error("hardwareId 必须是不含空格的稳定标识符");
      return await window.testforge.devices.saveHardware({
        formatVersion: 2, hardwareId, label: form.label.trim() || hardwareId, kind: "passive", ports,
        ...(live?.appearanceAssetId ? { appearanceAssetId: live.appearanceAssetId } : {})
      });
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={hardware ? "编辑硬件" : "添加硬件"}
      width={760}
      footer={<>
        <BundleActions kind="hardware" id={form.hardwareId} saved={Boolean(live)} onChanged={async () => { await onChanged(); onClose(); }} />
        <Btn onClick={onClose}>取消</Btn>
        <Btn variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !form.hardwareId.trim()}>
          {save.isPending ? "保存中…" : "保存"}
        </Btn>
      </>}
    >
      <div className="form-grid">
        <Field label="稳定 hardwareId" required><input className="input" {...field("hardwareId")} disabled={Boolean(hardware)} placeholder="DUT_1" /></Field>
        <Field label="显示名称" required><input className="input" {...field("label")} /></Field>
        <div className="span-2 form-note">被动 硬件不由 MCP Server 控制，仅用于接线建模。</div>
        <div className="span-2 editor-assets">
          <AppearanceImage
            hardwareId={form.hardwareId}
            assetId={live?.appearanceAssetId}
            saved={Boolean(live)}
            onChanged={(item) => setPorts(structuredClone(item.ports))}
          />
          <PortEditor
            hardwareId={form.hardwareId}
            ports={ports}
            saved={Boolean(live)}
            onChange={setPorts}
            onImageChanged={(item) => setPorts(structuredClone(item.ports))}
          />
        </div>
        {save.isError && <div className="alert span-2"><IconAlert size={15} /><span>{String(save.error)}</span></div>}
      </div>
    </Modal>
  );
}

/* --------------------------------- 辅助 --------------------------------- */

/** MCP 行左侧只显示连接状态。 */
function mcpRowStatuses(serverStatus?: ServerStatus): { dot: string; label: string; title?: string | undefined }[] {
  const mcpState = serverStatus?.mcp.state ?? "unknown";
  return [{
    dot: connDot(mcpState),
    label: mcpState === "online" ? "在线" : mcpState === "checking" ? "检测中" : "离线",
    title: serverStatus?.mcp.message
  }];
}

function connDot(state: string): string {
  if (state === "online") return "ok";
  if (state === "offline" || state === "error") return "bad";
  if (state === "checking") return "checking";
  return "muted";
}

function stateLabel(state: string): string {
  return ({ online: "在线", offline: "离线", checking: "检测中", error: "错误", unknown: "未知" } as Record<string, string>)[state] ?? state;
}
