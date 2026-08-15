import { useState } from "react";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { AgentIntegrationPreview, AgentIntegrationStatus, AgentToolInfo } from "@testforge/contracts/agents";
import type { DashboardSnapshot } from "@testforge/contracts/desktop";
import { errorMessage } from "../../shared/errors.js";
import {
  IconAlert, IconDownload, IconPlay, IconRefresh, IconStop, IconTrash
} from "../../shared/icons.js";
import { Badge, Btn, Dot, Modal } from "../../shared/ui.js";
import { PageHeader, PropRow, QueryGate } from "../../shared/layout.js";
import { queryKeys } from "../../shared/query-keys.js";

/* ------------------------------- Agent 接入页 ------------------------------- */

export function AgentIntegrationPage({ query, gateway, embedded = false }: { query: UseQueryResult<DashboardSnapshot>; gateway?: DashboardSnapshot["gateway"]; embedded?: boolean }) {
  if (embedded && gateway) {
    return (
      <section className="settings-section">
        <header>
          <h1>Agent 接入</h1>
          <p>管理 Gateway、Codex 一键接入、访问令牌、手动接入方式和 MCP 工具清单。</p>
        </header>
        <AgentConfig gateway={gateway} showHeader={false} />
      </section>
    );
  }
  return (
    <main className="page">
      <div className="page-inner">
        <QueryGate query={query}>
          {(data) => <AgentConfig gateway={data.gateway} />}
        </QueryGate>
      </div>
    </main>
  );
}

function AgentConfig({ gateway, showHeader = true }: { gateway: DashboardSnapshot["gateway"]; showHeader?: boolean }) {
  const [preview, setPreview] = useState<AgentIntegrationPreview>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const status = useQuery({
    queryKey: queryKeys.agentIntegration("codex"),
    queryFn: () => window.testforge.agents.status("codex"),
    refetchInterval: 15_000
  });
  const finish = async (result: AgentIntegrationStatus) => {
    setNotice(result.message);
    setActionError(undefined);
    await status.refetch();
  };
  const install = useMutation({
    mutationFn: () => window.testforge.agents.install("codex"),
    onSuccess: async (result) => { setPreview(undefined); await finish(result); },
    onError: (error) => setActionError(errorMessage(error))
  });
  const remove = useMutation({
    mutationFn: () => window.testforge.agents.remove("codex"),
    onSuccess: async (result) => { setRemoveOpen(false); await finish(result); },
    onError: (error) => setActionError(errorMessage(error))
  });
  const test = useMutation({
    mutationFn: () => window.testforge.agents.test("codex"),
    onSuccess: finish,
    onError: (error) => setActionError(errorMessage(error))
  });
  const rotate = useMutation({
    mutationFn: () => window.testforge.agents.rotateGatewayToken(),
    onSuccess: async (result) => { setRotateOpen(false); await finish(result); },
    onError: (error) => setActionError(errorMessage(error))
  });
  const current = status.data;
  const busy = install.isPending || remove.isPending || test.isPending || rotate.isPending;
  const primaryLabel = current?.state === "misconfigured" ? "修复 Codex 配置" : current?.state === "configured" ? "重新安装" : "接入 Codex";
  return (
    <>
      {showHeader && <PageHeader title="Agent 接入" />}
      <section className={`gateway-strip ${gateway.running ? "is-online" : "is-offline"}`}>
        <span className="gateway-mark"><Dot state={gateway.running ? "ok" : "bad"} /></span>
        <span className="gateway-copy"><strong>MCP Gateway {gateway.running ? "正在运行" : "未运行"}</strong><code>{gateway.endpoint}</code></span>
        <Badge tone={gateway.running ? "ok" : "bad"}>{gateway.toolCount} 个工具</Badge>
      </section>
      {!gateway.running && <div className="alert"><IconAlert size={15} /><span>TestForge 必须保持打开，Codex 才能连接本地 MCP Gateway。</span></div>}
      {notice && <div className="agent-notice success"><span>{notice}</span></div>}
      {(actionError || status.isError) && <div className="alert"><IconAlert size={15} /><span>{actionError ?? errorMessage(status.error)}</span></div>}

      <section className="panel agent-card">
        <header className="panel-head agent-card-head">
          <span><strong>Codex</strong><small>自动管理</small></span>
          <Badge tone={agentTone(current?.state)}>{agentStateLabel(current?.state)}</Badge>
        </header>
        <div className="agent-status-list">
          <AgentStatusRow label="Codex CLI" ok={Boolean(current?.cli.available)} value={current?.cli.available ? current.cli.version ?? current.cli.path ?? "已发现" : "未发现"} />
          <AgentStatusRow label="令牌环境变量" ok={current?.environment.state === "configured"} value={integrationPartLabel(current?.environment.state)} detail="TESTFORGE_MCP_TOKEN" />
          <AgentStatusRow label="MCP 配置" ok={current?.configuration.state === "configured"} value={integrationPartLabel(current?.configuration.state)} detail={current?.configuration.endpoint} />
          <AgentStatusRow label="最近连接" ok={Boolean(current?.lastClient)} value={current?.lastClient ? `${current.lastClient.name}${current.lastClient.version ? ` ${current.lastClient.version}` : ""}` : "等待 Codex 连接"} detail={current?.lastClient ? new Date(current.lastClient.connectedAt).toLocaleString() : undefined} neutral={!current?.lastClient} />
        </div>
        <footer className="agent-actions">
          <Btn
            variant="primary"
            disabled={busy || !gateway.running || current?.state === "unavailable" || status.isLoading}
            onClick={async () => {
              setActionError(undefined);
              try { setPreview(await window.testforge.agents.preview("codex")); }
              catch (error) { setActionError(errorMessage(error)); }
            }}
          >{primaryLabel}</Btn>
          <Btn icon={<IconRefresh size={14} className={test.isPending ? "spin" : undefined} />} disabled={busy} onClick={() => test.mutate()}>检测连接</Btn>
          {current?.configuration.state !== "missing" && <Btn variant="danger" disabled={busy} onClick={() => setRemoveOpen(true)}>移除接入</Btn>}
        </footer>
      </section>

      <details className="agent-details">
        <summary>高级设置</summary>
        <div className="agent-details-body">
          <PropRow label="Gateway 地址"><code>{gateway.endpoint}</code></PropRow>
          <PropRow label="环境变量"><code>TESTFORGE_MCP_TOKEN</code></PropRow>
          <PropRow label="Codex CLI"><code>{current?.cli.path ?? "未发现"}</code></PropRow>
          <PropRow label="手动命令"><code>codex mcp add testforge --url {gateway.endpoint} --bearer-token-env-var TESTFORGE_MCP_TOKEN</code></PropRow>
          <div className="agent-secret-row">
            <span className="muted-copy">Gateway 令牌仅保存在主进程和受管环境变量中，不下发到渲染进程。</span>
            <Btn variant="danger" disabled={busy} onClick={() => setRotateOpen(true)}>轮换令牌</Btn>
          </div>
        </div>
      </details>

      <details className="agent-details">
        <summary>其他 Agent 手动接入</summary>
        <div className="agent-details-body manual-agent-grid">
          <div><strong>Claude Code</strong><p>在 Claude Code 的 MCP 设置中添加 HTTP Server，并配置 Authorization 标头。</p></div>
          <div><strong>OpenCode（外部）</strong><p>外部 OpenCode 也可手动添加相同端点与 Bearer；内嵌 OpenCode 已自动配置，无需手动接入。</p></div>
          <pre className="code-block span-2">{`${gateway.endpoint}\nAuthorization: Bearer <从受保护环境变量读取>`}</pre>
        </div>
      </details>

      <AgentToolsSection />

      <Modal open={Boolean(preview)} onClose={() => !install.isPending && setPreview(undefined)} title={current?.state === "misconfigured" ? "修复 Codex 接入" : "接入 Codex"} footer={<><Btn disabled={install.isPending} onClick={() => setPreview(undefined)}>取消</Btn><Btn variant="primary" disabled={install.isPending} onClick={() => install.mutate()}>{install.isPending ? "正在配置…" : "确认并接入"}</Btn></>}>
        {preview && <div className="agent-confirm"><p>TestForge 将自动完成以下操作：</p><ul>{preview.actions.map((action) => <li key={action}>{action}</li>)}</ul>{preview.replacesExisting && <div className="agent-notice warn">现有 <code>testforge</code> MCP 条目将被替换，其他 MCP 配置不受影响。</div>}<p className="form-note">配置文件会先备份。整个过程不会把令牌写入界面或命令行参数。</p></div>}
      </Modal>
      <Modal open={removeOpen} onClose={() => !remove.isPending && setRemoveOpen(false)} title="移除 Codex 接入" footer={<><Btn disabled={remove.isPending} onClick={() => setRemoveOpen(false)}>取消</Btn><Btn variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? "正在移除…" : "确认移除"}</Btn></>}>
        <p>将删除 Codex 中的 <code>testforge</code> MCP 条目和用户环境变量 <code>TESTFORGE_MCP_TOKEN</code>。</p>
      </Modal>
      <Modal open={rotateOpen} onClose={() => !rotate.isPending && setRotateOpen(false)} title="轮换 Gateway 令牌" footer={<><Btn disabled={rotate.isPending} onClick={() => setRotateOpen(false)}>取消</Btn><Btn variant="danger" disabled={rotate.isPending} onClick={() => rotate.mutate()}>{rotate.isPending ? "正在轮换…" : "确认轮换"}</Btn></>}>
        <p>旧令牌会立即失效。若 Codex 已接入，TestForge 会同步更新环境变量，完成后需要重启 Codex。</p>
      </Modal>
    </>
  );
}

function AgentStatusRow({ label, ok, value, detail, neutral = false }: { label: string; ok: boolean; value: string; detail?: string | undefined; neutral?: boolean }) {
  return <div className="agent-status-row"><Dot state={neutral ? "muted" : ok ? "ok" : "bad"} /><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span><span className={neutral ? "s-muted" : ok ? "s-ok" : "s-bad"}>{value}</span></div>;
}

/** Every tool the gateway will let an agent call, builtin first then per-server, with a one-click
 *  JSON export of the same catalog the MCP `tools/list` response is built from. */
function AgentToolsSection() {
  const [notice, setNotice] = useState<string>();
  const tools = useQuery({ queryKey: queryKeys.agentTools, queryFn: () => window.testforge.agents.listTools(), refetchInterval: 10_000 });
  const exportTools = useMutation({
    mutationFn: () => window.testforge.system.exportText("testforge-tools.json", JSON.stringify(tools.data ?? [], null, 2)),
    onSuccess: (path) => setNotice(path ? `已导出到 ${path}` : undefined)
  });
  const items = tools.data ?? [];
  return (
    <details className="agent-details">
      <summary>可调用的工具 <Badge tone="muted">{items.length}</Badge></summary>
      <div className="agent-details-body">
        <div className="agent-section-bar">
          <Btn variant="subtle" icon={<IconDownload size={14} />} disabled={!items.length || exportTools.isPending} onClick={() => exportTools.mutate()}>导出工具清单</Btn>
          {notice && <span className="s-muted">{notice}</span>}
        </div>
        {tools.isLoading && <div className="list-empty">正在加载工具…</div>}
        <div className="agent-tool-list">
          {items.map((tool) => <AgentToolRow key={`${tool.kind}:${tool.name}`} tool={tool} />)}
        </div>
      </div>
    </details>
  );
}

function AgentToolRow({ tool }: { tool: AgentToolInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`agent-tool${open ? " open" : ""}`}>
      <button className="agent-tool-head" onClick={() => setOpen((value) => !value)}>
        <span><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</span>
        <span className="agent-tool-tags">
          <Badge tone={tool.kind === "builtin" ? "accent" : "muted"}>{tool.kind === "builtin" ? "内建" : tool.serverId}</Badge>
          <span>{open ? "收起" : "展开"}</span>
        </span>
      </button>
      {open && <pre className="code-block schema">{JSON.stringify(tool.inputSchema, null, 2)}</pre>}
    </article>
  );
}

function agentTone(state?: AgentIntegrationStatus["state"]): "muted" | "ok" | "warn" | "bad" {
  if (state === "configured") return "ok";
  if (state === "misconfigured") return "warn";
  if (state === "error" || state === "unavailable") return "bad";
  return "muted";
}

function agentStateLabel(state?: AgentIntegrationStatus["state"]): string {
  return ({ configured: "已配置", misconfigured: "需要修复", not_installed: "未接入", unavailable: "不可用", error: "检测失败" } as Record<string, string>)[state ?? ""] ?? "检测中";
}

function integrationPartLabel(state?: "missing" | "mismatch" | "configured"): string {
  return ({ configured: "正常", mismatch: "不匹配", missing: "未配置" } as Record<string, string>)[state ?? ""] ?? "检测中";
}
