import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { AgentIntegrationPreview, AgentIntegrationStatus } from "@hardwareharness/contracts/agents";
import type { DashboardSnapshot } from "@hardwareharness/contracts/operations";
import { PlugZapIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { useAgentIntegration } from "../../lib/queries.js";
import { Badge, Button, StatusLamp, cn, toneText, type Tone } from "../../ui";
import { AgentToolsSection } from "./AgentToolsSection.js";
import { ActionDialog, Disclosure, Notice, PropRow, SettingsCard, SettingsHeader } from "./SettingsLayout.js";

type Gateway = DashboardSnapshot["gateway"];
type ConfirmKind = "remove" | "rotate" | undefined;

const TOKEN_ENV = "HARDWAREHARNESS_MCP_TOKEN";

/** Gateway status, Codex one-click integration, token rotation, manual setup and the tool catalog. */
export function AgentIntegrationPage({ gateway }: { gateway: Gateway }) {
  const status = useAgentIntegration("codex");
  const [preview, setPreview] = useState<AgentIntegrationPreview>();
  const [dialog, setDialog] = useState<ConfirmKind>();
  const [notice, setNotice] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const finish = async (result: AgentIntegrationStatus) => {
    setNotice(result.message);
    setActionError(undefined);
    await status.refetch();
  };
  const fail = (reason: unknown) => setActionError(errorMessage(reason));
  const install = useMutation({
    mutationFn: () => window.hardwareharness.agents.install({ agent: "codex" }),
    onSuccess: async (result) => { setPreview(undefined); await finish(result); },
    onError: fail
  });
  const remove = useMutation({
    mutationFn: () => window.hardwareharness.agents.remove({ agent: "codex" }),
    onSuccess: async (result) => { setDialog(undefined); await finish(result); },
    onError: fail
  });
  const test = useMutation({
    mutationFn: () => window.hardwareharness.agents.test({ agent: "codex" }),
    onSuccess: finish,
    onError: fail
  });
  const rotate = useMutation({
    mutationFn: () => window.hardwareharness.agents.rotateGatewayToken(),
    onSuccess: async (result) => { setDialog(undefined); await finish(result); },
    onError: fail
  });
  const openPreview = async () => {
    setActionError(undefined);
    try {
      setPreview(await window.hardwareharness.agents.preview({ agent: "codex" }));
    } catch (reason) {
      fail(reason);
    }
  };

  const current = status.data;
  const busy = install.isPending || remove.isPending || test.isPending || rotate.isPending;
  const misconfigured = current?.state === "misconfigured";
  const primaryLabel = misconfigured ? "修复 Codex 配置" : current?.state === "configured" ? "重新安装" : "接入 Codex";
  const manualCommand =
    `codex mcp add hardwareharness --url ${gateway.endpoint} --bearer-token-env-var ${TOKEN_ENV}`;

  return (
    <>
      <SettingsHeader
        title="Agent 接入"
        description="管理 MCP Gateway、Codex 一键接入、访问令牌、手动接入方式和 MCP 工具清单。"
      />
      <div className="grid gap-4">
        <GatewayCard gateway={gateway} />
        {notice && <Notice tone="pass">{notice}</Notice>}
        {(actionError || status.isError) && <Notice tone="fail">{actionError ?? errorMessage(status.error)}</Notice>}

        <SettingsCard
          title="Codex"
          meta="自动管理"
          actions={<Badge tone={agentTone(current?.state)}>{agentStateLabel(current?.state)}</Badge>}
          footer={
            <>
              <Button
                variant="primary"
                disabled={busy || !gateway.running || current?.state === "unavailable" || status.isLoading}
                onClick={() => void openPreview()}
              >
                <PlugZapIcon />
                {primaryLabel}
              </Button>
              <Button disabled={busy} onClick={() => test.mutate()}>
                <RefreshCwIcon className={cn(test.isPending && "animate-spin")} />
                检测连接
              </Button>
              {current?.configuration.state !== "missing" && (
                <Button variant="danger" disabled={busy} onClick={() => setDialog("remove")}>
                  <Trash2Icon />
                  移除接入
                </Button>
              )}
            </>
          }
        >
          <StatusRow
            label="Codex CLI"
            ok={Boolean(current?.cli.available)}
            value={current?.cli.available ? current.cli.version ?? current.cli.path ?? "已发现" : "未发现"}
          />
          <StatusRow
            label="令牌环境变量"
            ok={current?.environment.state === "configured"}
            value={partLabel(current?.environment.state)}
            detail={TOKEN_ENV}
          />
          <StatusRow
            label="MCP 配置"
            ok={current?.configuration.state === "configured"}
            value={partLabel(current?.configuration.state)}
            detail={current?.configuration.endpoint}
          />
          <StatusRow
            label="最近连接"
            ok={Boolean(current?.lastClient)}
            neutral={!current?.lastClient}
            value={current?.lastClient ? clientLabel(current.lastClient) : "等待 Codex 连接"}
            detail={current?.lastClient ? new Date(current.lastClient.connectedAt).toLocaleString() : undefined}
          />
        </SettingsCard>

        <Disclosure title="高级设置">
          <PropRow label="Gateway 地址" mono>{gateway.endpoint}</PropRow>
          <PropRow label="环境变量" mono>{TOKEN_ENV}</PropRow>
          <PropRow label="Codex CLI" mono>{current?.cli.path ?? "未发现"}</PropRow>
          <PropRow label="手动命令" mono>{manualCommand}</PropRow>
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <span className="text-xs text-fg-3">Gateway 令牌仅保存在主进程和受管环境变量中，不下发到渲染进程。</span>
            <Button variant="danger" disabled={busy} onClick={() => setDialog("rotate")}>轮换令牌</Button>
          </div>
        </Disclosure>

        <Disclosure title="其他 Agent 手动接入">
          <div className="grid gap-3 p-3 sm:grid-cols-2">
            <ManualAgent name="Claude Code">
              在 Claude Code 的 MCP 设置中添加 HTTP Server，并配置 Authorization 标头。
            </ManualAgent>
            <ManualAgent name="OpenCode（外部）">
              外部 OpenCode 也可手动添加相同端点与 Bearer；内嵌 OpenCode 已自动配置，无需手动接入。
            </ManualAgent>
            <pre
              className={cn(
                "col-span-full m-0 overflow-auto rounded-sm border border-line bg-surface-0 px-3 py-2",
                "font-mono text-xs text-fg-2"
              )}
            >
              {`${gateway.endpoint}\nAuthorization: Bearer <从受保护环境变量读取>`}
            </pre>
          </div>
        </Disclosure>

        <AgentToolsSection />
      </div>

      <ActionDialog
        open={Boolean(preview)}
        title={misconfigured ? "修复 Codex 接入" : "接入 Codex"}
        busy={install.isPending}
        confirmLabel="确认并接入"
        busyLabel="正在配置…"
        onConfirm={() => install.mutate()}
        onClose={() => setPreview(undefined)}
      >
        <p className="text-fg">HardwareHarness 将自动完成以下操作：</p>
        <ul className="list-disc space-y-1 pl-5">
          {preview?.actions.map((action) => <li key={action}>{action}</li>)}
        </ul>
        {preview?.replacesExisting && (
          <Notice tone="invalid">
            现有 <code className="font-mono">hardwareharness</code> MCP 条目将被替换，其他 MCP 配置不受影响。
          </Notice>
        )}
        <p className="text-xs text-fg-3">配置文件会先备份。整个过程不会把令牌写入界面或命令行参数。</p>
      </ActionDialog>
      <ActionDialog
        open={dialog === "remove"}
        title="移除 Codex 接入"
        busy={remove.isPending}
        danger
        confirmLabel="确认移除"
        busyLabel="正在移除…"
        onConfirm={() => remove.mutate()}
        onClose={() => setDialog(undefined)}
      >
        <p>
          将删除 Codex 中的 <code className="font-mono text-fg">hardwareharness</code> MCP 条目和用户环境变量{" "}
          <code className="font-mono text-fg">{TOKEN_ENV}</code>。
        </p>
      </ActionDialog>
      <ActionDialog
        open={dialog === "rotate"}
        title="轮换 Gateway 令牌"
        busy={rotate.isPending}
        danger
        confirmLabel="确认轮换"
        busyLabel="正在轮换…"
        onConfirm={() => rotate.mutate()}
        onClose={() => setDialog(undefined)}
      >
        <p>旧令牌会立即失效。若 Codex 已接入，HardwareHarness 会同步更新环境变量，完成后需要重启 Codex。</p>
      </ActionDialog>
    </>
  );
}

function GatewayCard({ gateway }: { gateway: Gateway }) {
  return (
    <SettingsCard
      title="MCP Gateway"
      actions={<Badge mono tone={gateway.running ? "pass" : "fail"}>{gateway.toolCount} 个工具</Badge>}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <StatusLamp tone={gateway.running ? "pass" : "fail"} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-sm font-medium text-fg">MCP Gateway {gateway.running ? "正在运行" : "未运行"}</span>
          <code className="truncate font-mono text-xs text-fg-3">{gateway.endpoint}</code>
        </div>
      </div>
      {!gateway.running && (
        <Notice tone="fail" className="mx-3 mb-3">HardwareHarness 必须保持打开，Codex 才能连接本地 MCP Gateway。</Notice>
      )}
    </SettingsCard>
  );
}

function StatusRow({ label, ok, value, detail, neutral = false }: {
  label: string;
  ok: boolean;
  value: string;
  detail?: string | undefined;
  neutral?: boolean;
}) {
  const tone: Tone = neutral ? "neutral" : ok ? "pass" : "fail";
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0">
      <StatusLamp tone={tone} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        {detail && <span className="truncate font-mono text-2xs text-fg-3">{detail}</span>}
      </span>
      <span className={cn("tf-num max-w-[45%] truncate text-xs", neutral ? "text-fg-3" : toneText[tone])}>{value}</span>
    </div>
  );
}

function ManualAgent({ name, children }: { name: string; children: string }) {
  return (
    <div className="grid content-start gap-1">
      <span className="text-sm font-medium text-fg">{name}</span>
      <p className="text-xs leading-5 text-fg-3">{children}</p>
    </div>
  );
}

function clientLabel(client: NonNullable<AgentIntegrationStatus["lastClient"]>) {
  return client.version ? `${client.name} ${client.version}` : client.name;
}

function agentTone(state?: AgentIntegrationStatus["state"]): Tone {
  if (state === "configured") return "pass";
  if (state === "misconfigured") return "invalid";
  if (state === "error" || state === "unavailable") return "fail";
  return "neutral";
}

const agentStateLabels: Record<AgentIntegrationStatus["state"], string> = {
  configured: "已配置",
  misconfigured: "需要修复",
  not_installed: "未接入",
  unavailable: "不可用",
  error: "检测失败"
};

function agentStateLabel(state?: AgentIntegrationStatus["state"]): string {
  return state ? agentStateLabels[state] : "检测中";
}

const partLabels = { configured: "正常", mismatch: "不匹配", missing: "未配置" } as const;

function partLabel(state?: keyof typeof partLabels): string {
  return state ? partLabels[state] : "检测中";
}
