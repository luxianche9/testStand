import { useState } from "react";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { AgentIntegrationPreview, AgentIntegrationStatus, AgentToolInfo } from "@hardwareharness/contracts/agents";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import { CircleAlertIcon, DownloadIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";
import { Badge, badgeVariantFromTone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dot } from "../../shared/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter } from "../../shared/ui/dialog";
import { QueryGate } from "../../shared/layout.js";
import { queryKeys } from "../../shared/query-keys.js";
import { cn } from "../../shared/ui/cn";

/* ------------------------------- Agent 接入页 ------------------------------- */

export function AgentIntegrationPage({ query, gateway, embedded = false }: { query: UseQueryResult<DashboardSnapshot>; gateway?: DashboardSnapshot["gateway"]; embedded?: boolean }) {
  if (embedded && gateway) {
    return <AgentConfig gateway={gateway} />;
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-[880px] px-6 pt-7 pb-18 md:px-10">
        <QueryGate query={query}>
          {(data) => <AgentConfig gateway={data.gateway} showHeader />}
        </QueryGate>
      </div>
    </main>
  );
}

function AgentConfig({ gateway, showHeader = false }: { gateway: DashboardSnapshot["gateway"]; showHeader?: boolean }) {
  const [preview, setPreview] = useState<AgentIntegrationPreview>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const status = useQuery({
    queryKey: queryKeys.agentIntegration("codex"),
    queryFn: () => window.hardwareharness.agents.status("codex"),
    refetchInterval: 15_000
  });
  const finish = async (result: AgentIntegrationStatus) => {
    setNotice(result.message);
    setActionError(undefined);
    await status.refetch();
  };
  const install = useMutation({
    mutationFn: () => window.hardwareharness.agents.install("codex"),
    onSuccess: async (result) => { setPreview(undefined); await finish(result); },
    onError: (error) => setActionError(errorMessage(error))
  });
  const remove = useMutation({
    mutationFn: () => window.hardwareharness.agents.remove("codex"),
    onSuccess: async (result) => { setRemoveOpen(false); await finish(result); },
    onError: (error) => setActionError(errorMessage(error))
  });
  const test = useMutation({
    mutationFn: () => window.hardwareharness.agents.test("codex"),
    onSuccess: finish,
    onError: (error) => setActionError(errorMessage(error))
  });
  const rotate = useMutation({
    mutationFn: () => window.hardwareharness.agents.rotateGatewayToken(),
    onSuccess: async (result) => { setRotateOpen(false); await finish(result); },
    onError: (error) => setActionError(errorMessage(error))
  });
  const current = status.data;
  const busy = install.isPending || remove.isPending || test.isPending || rotate.isPending;
  const primaryLabel = current?.state === "misconfigured" ? "修复 Codex 配置" : current?.state === "configured" ? "重新安装" : "接入 Codex";
  return (
    <section className="mx-auto max-w-[880px]">
      {showHeader && (
        <header className="mb-5 pb-4">
          <h1 className="m-0 text-xl font-semibold tracking-tight">Agent 接入</h1>
          <p className="mt-1.5 mb-0 text-sm text-muted-foreground">管理 Gateway、Codex 一键接入、访问令牌、手动接入方式和 MCP 工具清单。</p>
        </header>
      )}
      <div className={cn("flex items-center gap-3 rounded-xl px-4 py-3 shadow-sm ring-1", gateway.running ? "bg-success/8 ring-success/35" : "bg-secondary/40 ring-border")}>
        <Dot state={gateway.running ? "ok" : "bad"} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="text-sm font-semibold">MCP Gateway {gateway.running ? "正在运行" : "未运行"}</strong>
          <code className="truncate text-xs text-muted-foreground">{gateway.endpoint}</code>
        </span>
        <Badge variant={badgeVariantFromTone(gateway.running ? "ok" : "bad")}>{gateway.toolCount} 个工具</Badge>
      </div>
      {!gateway.running && (
        <div className="mt-3 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
          <CircleAlertIcon size={15} className="mt-0.5 shrink-0" />
          <span>HardwareHarness 必须保持打开，Codex 才能连接本地 MCP Gateway。</span>
        </div>
      )}
      {notice && <div className="mt-3 rounded-md border border-success/35 bg-success/10 px-3.5 py-2.5 text-xs text-success">{notice}</div>}
      {(actionError || status.isError) && (
        <div className="mt-3 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
          <CircleAlertIcon size={15} className="mt-0.5 shrink-0" />
          <span className="break-anywhere">{actionError ?? errorMessage(status.error)}</span>
        </div>
      )}

      <section className="mt-4 overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
        <header className="flex items-center justify-between bg-secondary/50 px-4 py-3">
          <div className="grid gap-0.5">
            <strong className="text-sm font-semibold">Codex</strong>
            <span className="text-[11px] text-muted-foreground">自动管理</span>
          </div>
          <Badge variant={badgeVariantFromTone(agentTone(current?.state))}>{agentStateLabel(current?.state)}</Badge>
        </header>
        <div>
          <AgentStatusRow label="Codex CLI" ok={Boolean(current?.cli.available)} value={current?.cli.available ? current.cli.version ?? current.cli.path ?? "已发现" : "未发现"} />
          <AgentStatusRow label="令牌环境变量" ok={current?.environment.state === "configured"} value={integrationPartLabel(current?.environment.state)} detail="HARDWAREHARNESS_MCP_TOKEN" />
          <AgentStatusRow label="MCP 配置" ok={current?.configuration.state === "configured"} value={integrationPartLabel(current?.configuration.state)} detail={current?.configuration.endpoint} />
          <AgentStatusRow label="最近连接" ok={Boolean(current?.lastClient)} value={current?.lastClient ? `${current.lastClient.name}${current.lastClient.version ? ` ${current.lastClient.version}` : ""}` : "等待 Codex 连接"} detail={current?.lastClient ? new Date(current.lastClient.connectedAt).toLocaleString() : undefined} neutral={!current?.lastClient} />
        </div>
        <footer className="flex flex-wrap gap-2 bg-secondary/30 px-4 py-3">
          <Button
            disabled={busy || !gateway.running || current?.state === "unavailable" || status.isLoading}
            onClick={async () => {
              setActionError(undefined);
              try { setPreview(await window.hardwareharness.agents.preview("codex")); }
              catch (error) { setActionError(errorMessage(error)); }
            }}
          >{primaryLabel}</Button>
          <Button variant="outline" disabled={busy} onClick={() => test.mutate()}>
            <RefreshCwIcon size={14} className={test.isPending ? "animate-spin" : undefined} />检测连接
          </Button>
          {current?.configuration.state !== "missing" && <Button variant="destructive" disabled={busy} onClick={() => setRemoveOpen(true)}><Trash2Icon size={14} />移除接入</Button>}
        </footer>
      </section>

      <details className="mt-4 overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none hover:bg-accent">高级设置</summary>
        <div className="bg-secondary/20">
          <PropRow label="Gateway 地址"><code>{gateway.endpoint}</code></PropRow>
          <PropRow label="环境变量"><code>HARDWAREHARNESS_MCP_TOKEN</code></PropRow>
          <PropRow label="Codex CLI"><code>{current?.cli.path ?? "未发现"}</code></PropRow>
          <PropRow label="手动命令"><code>codex mcp add hardwareharness --url {gateway.endpoint} --bearer-token-env-var HARDWAREHARNESS_MCP_TOKEN</code></PropRow>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-xs text-muted-foreground">Gateway 令牌仅保存在主进程和受管环境变量中，不下发到渲染进程。</span>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => setRotateOpen(true)}>轮换令牌</Button>
          </div>
        </div>
      </details>

      <details className="mt-4 overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none hover:bg-accent">其他 Agent 手动接入</summary>
        <div className="grid gap-4 bg-secondary/20 px-4 py-4 sm:grid-cols-2">
          <div><strong className="text-sm font-medium">Claude Code</strong><p className="mt-1 mb-0 text-xs text-muted-foreground">在 Claude Code 的 MCP 设置中添加 HTTP Server，并配置 Authorization 标头。</p></div>
          <div><strong className="text-sm font-medium">OpenCode（外部）</strong><p className="mt-1 mb-0 text-xs text-muted-foreground">外部 OpenCode 也可手动添加相同端点与 Bearer；内嵌 OpenCode 已自动配置，无需手动接入。</p></div>
          <pre className="col-span-full m-0 overflow-auto rounded-md bg-secondary/60 px-3.5 py-3 text-xs">{`${gateway.endpoint}\nAuthorization: Bearer <从受保护环境变量读取>`}</pre>
        </div>
      </details>

      <AgentToolsSection />

      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open && !install.isPending) setPreview(undefined); }}>
        <DialogContent size="sm">
          <DialogHeader title={current?.state === "misconfigured" ? "修复 Codex 接入" : "接入 Codex"} onClose={() => !install.isPending && setPreview(undefined)} />
          <DialogBody>
            {preview && (
              <div className="grid gap-3 text-sm">
                <p className="m-0">HardwareHarness 将自动完成以下操作：</p>
                <ul className="m-0 list-disc space-y-1 pl-5">{preview.actions.map((action) => <li key={action}>{action}</li>)}</ul>
                {preview.replacesExisting && <div className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">现有 <code>hardwareharness</code> MCP 条目将被替换，其他 MCP 配置不受影响。</div>}
                <p className="m-0 text-xs text-muted-foreground">配置文件会先备份。整个过程不会把令牌写入界面或命令行参数。</p>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={install.isPending} onClick={() => setPreview(undefined)}>取消</Button>
            <Button disabled={install.isPending} onClick={() => install.mutate()}>{install.isPending ? "正在配置…" : "确认并接入"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={removeOpen} onOpenChange={(open) => { if (!open && !remove.isPending) setRemoveOpen(false); }}>
        <DialogContent size="sm">
          <DialogHeader title="移除 Codex 接入" onClose={() => !remove.isPending && setRemoveOpen(false)} />
          <DialogBody>
            <p className="m-0 text-sm">将删除 Codex 中的 <code>hardwareharness</code> MCP 条目和用户环境变量 <code>HARDWAREHARNESS_MCP_TOKEN</code>。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setRemoveOpen(false)}>取消</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? "正在移除…" : "确认移除"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={rotateOpen} onOpenChange={(open) => { if (!open && !rotate.isPending) setRotateOpen(false); }}>
        <DialogContent size="sm">
          <DialogHeader title="轮换 Gateway 令牌" onClose={() => !rotate.isPending && setRotateOpen(false)} />
          <DialogBody>
            <p className="m-0 text-sm">旧令牌会立即失效。若 Codex 已接入，HardwareHarness 会同步更新环境变量，完成后需要重启 Codex。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={rotate.isPending} onClick={() => setRotateOpen(false)}>取消</Button>
            <Button variant="destructive" disabled={rotate.isPending} onClick={() => rotate.mutate()}>{rotate.isPending ? "正在轮换…" : "确认轮换"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[140px_minmax(0,1fr)] items-center gap-3 px-4 py-1.5 odd:bg-secondary/20">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 wrap-anywhere text-sm [&_code]:font-mono [&_code]:text-xs">{children}</span>
    </div>
  );
}

function AgentStatusRow({ label, ok, value, detail, neutral = false }: { label: string; ok: boolean; value: string; detail?: string | undefined; neutral?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-sm odd:bg-secondary/20">
      <Dot state={neutral ? "muted" : ok ? "ok" : "bad"} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="font-medium">{label}</strong>
        {detail && <small className="truncate text-xs text-muted-foreground">{detail}</small>}
      </span>
      <span className={cn("text-xs", neutral ? "text-muted-foreground" : ok ? "text-success" : "text-destructive")}>{value}</span>
    </div>
  );
}

/** Every tool the gateway will let an agent call, builtin first then per-server, with a one-click
 *  JSON export of the same catalog the MCP `tools/list` response is built from. */
function AgentToolsSection() {
  const [notice, setNotice] = useState<string>();
  const tools = useQuery({ queryKey: queryKeys.agentTools, queryFn: () => window.hardwareharness.agents.listTools(), refetchInterval: 10_000 });
  const exportTools = useMutation({
    mutationFn: () => window.hardwareharness.system.exportText("hardwareharness-tools.json", JSON.stringify(tools.data ?? [], null, 2)),
    onSuccess: (path) => setNotice(path ? `已导出到 ${path}` : undefined)
  });
  const items = tools.data ?? [];
  return (
    <details className="mt-4 overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium select-none hover:bg-accent">可调用的工具 <Badge variant="secondary">{items.length}</Badge></summary>
      <div className="bg-secondary/20 px-4 py-3">
        <div className="mb-3 flex items-center gap-3">
          <Button variant="ghost" size="sm" disabled={!items.length || exportTools.isPending} onClick={() => exportTools.mutate()}><DownloadIcon size={14} />导出工具清单</Button>
          {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
        </div>
        {tools.isLoading && <div className="py-6 text-center text-sm text-muted-foreground">正在加载工具…</div>}
        <div className="grid gap-2">
          {items.map((tool) => <AgentToolRow key={`${tool.kind}:${tool.name}`} tool={tool} />)}
        </div>
      </div>
    </details>
  );
}

function AgentToolRow({ tool }: { tool: AgentToolInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
      <button className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-accent" onClick={() => setOpen((value) => !value)}>
        <span className="grid min-w-0 gap-0.5">
          <strong className="text-sm font-medium">{tool.name}</strong>
          {tool.description && <small className="text-xs text-muted-foreground">{tool.description}</small>}
        </span>
        <span className="flex flex-none items-center gap-2">
          <Badge variant={tool.kind === "builtin" ? "default" : "secondary"}>{tool.kind === "builtin" ? "内建" : tool.serverId}</Badge>
          <span className="text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
        </span>
      </button>
      {open && <pre className="m-0 max-h-64 overflow-auto bg-secondary/60 px-3.5 py-3 font-mono text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre>}
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
