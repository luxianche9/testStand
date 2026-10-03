import type { OpenCodeRuntimeStatus } from "@teststand/contracts/agents";
import type { LlmSettings } from "@teststand/contracts/storage";
import { AlertCircleIcon, BotIcon, KeyRoundIcon, SettingsIcon, SquareIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "../../lib/errors.js";
import { Button, cn, IconButton, Spinner, StatusLamp, type Tone } from "../../ui";

function StatePanel({ icon, tone = "neutral", title, body, gatewayRunning = true, actions }: {
  icon: ReactNode;
  tone?: Tone;
  title: string;
  body: ReactNode;
  gatewayRunning?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
      <section className="flex max-w-sm flex-col items-center text-center">
        <div
          aria-hidden
          className={cn(
            "mb-3 grid size-10 place-items-center rounded-md border border-line-strong bg-surface-0 [&_svg]:size-5",
            tone === "fail" ? "border-fail/40 text-fail" : "text-fg-3"
          )}
        >
          {icon}
        </div>
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-2">{body}</p>
        {!gatewayRunning && (
          <p
            className={cn(
              "mt-3 flex items-start gap-2 rounded-sm border border-signal/40 bg-signal/6 px-2.5 py-1.5",
              "text-start text-xs text-fg-2"
            )}
          >
            <StatusLamp tone="signal" className="mt-1" />
            MCP Gateway 当前未运行，启动后设备工具仍可能不可用。
          </p>
        )}
        {actions && <div className="mt-4">{actions}</div>}
      </section>
    </div>
  );
}

export function RuntimeEmptyState({ status, settings, loading, error, gatewayRunning, onOpenSettings }: {
  status: OpenCodeRuntimeStatus | undefined;
  settings: LlmSettings | undefined;
  loading: boolean;
  error: string | undefined;
  gatewayRunning: boolean;
  onOpenSettings: () => void;
}) {
  const settingsButton = (variant: "primary" | "outline") => (
    <Button size="sm" variant={variant} onClick={onOpenSettings}><SettingsIcon />打开设置</Button>
  );
  let icon: ReactNode = <BotIcon />;
  let tone: Tone = "neutral";
  let title = "正在读取助手状态";
  let body = "请稍候…";
  let actions: ReactNode;
  if (!loading && !settings?.apiKeyConfigured) {
    icon = <KeyRoundIcon />;
    title = "先完成模型配置";
    body = "填写 OpenAI 兼容地址、模型 ID 和 API Key。保存有效密钥后，OpenCode 会自动启动。";
    actions = settingsButton("primary");
  } else if (status?.state === "starting" || status?.state === "stopping") {
    icon = <Spinner className="size-5" />;
    title = status.state === "starting" ? "正在启动 OpenCode" : "正在停止 OpenCode";
    body = status.state === "starting" ? "窗口保持可用，启动完成后会自动进入会话。" : "正在回收本地 sidecar 进程。";
  } else if (status?.state === "error" || error) {
    icon = <AlertCircleIcon />;
    tone = "fail";
    title = "OpenCode 启动失败";
    body = error ?? status?.message ?? "请检查模型配置后重试。";
    actions = settingsButton("outline");
  } else if (status?.state === "running" && (!status.workspace || status.workspaceState !== "ready")) {
    icon = <AlertCircleIcon />;
    tone = "fail";
    title = "OpenCode 工作区不可用";
    body = "请重新打开项目文件夹，侧栏只会加载当前工作区的会话。";
  } else if (status?.state === "stopped") {
    icon = <SquareIcon />;
    title = "OpenCode 已停止";
    body = status?.workspaceState === "requires_project" ? "请先打开项目文件夹。" : "请在设置页启动 OpenCode，本地会话历史会保留。";
    actions = settingsButton("primary");
  }
  return (
    <StatePanel icon={icon} tone={tone} title={title} body={body} gatewayRunning={gatewayRunning} actions={actions} />
  );
}

export function SessionResolutionState({ error, onRetry }: { error: unknown | undefined; onRetry: () => void }) {
  const hasError = error !== undefined;
  return (
    <StatePanel
      icon={hasError ? <AlertCircleIcon /> : <Spinner className="size-5" />}
      tone={hasError ? "fail" : "neutral"}
      title={hasError ? "恢复工作区会话失败" : "正在恢复工作区会话"}
      body={hasError ? errorMessage(error) : "正在查找当前项目最近使用的会话；如果没有，将自动创建新对话。"}
      actions={hasError && <Button size="sm" variant="outline" onClick={onRetry}>重试</Button>}
    />
  );
}

/** Floating strip over the thread for runtime errors and gateway warnings. */
export function SidebarNotice({ role, tone, className, dismissLabel, onDismiss, children }: {
  role: "alert" | "status";
  tone: "fail" | "signal";
  className: string;
  dismissLabel?: string;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className={cn(
        "absolute z-40 flex items-start gap-2 rounded-sm border bg-surface-3 px-2.5 py-2 text-xs text-fg",
        "animate-fade-in shadow-overlay",
        tone === "fail" ? "border-fail/45" : "border-signal/45",
        className
      )}
    >
      {tone === "fail"
        ? <AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-fail" />
        : <StatusLamp tone="signal" className="mt-1" />}
      <div className="min-w-0 flex-1">{children}</div>
      {dismissLabel && onDismiss && (
        <IconButton label={dismissLabel} size="icon-xs" className="-me-1 -mt-0.5" onClick={onDismiss}>
          <XIcon />
        </IconButton>
      )}
    </div>
  );
}
