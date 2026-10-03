import { useOpenCodeSession } from "@assistant-ui/react-opencode";
import type { OpenCodeRuntimeStatus } from "@teststand/contracts/agents";
import { PanelLeftIcon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { IconButton, StatusLamp, Tooltip, type Tone } from "../../ui";

const stateLabels: Record<OpenCodeRuntimeStatus["state"], string> = {
  running: "已就绪",
  starting: "启动中",
  stopping: "停止中",
  stopped: "已停止",
  error: "启动失败"
};

const stateTones: Record<OpenCodeRuntimeStatus["state"], Tone> = {
  running: "pass",
  starting: "run",
  stopping: "run",
  stopped: "neutral",
  error: "fail"
};

export type HeaderProps = {
  status: OpenCodeRuntimeStatus | undefined;
  onClose: () => void;
};

/** Drawer toggle; `trigger` binds it to the surrounding thread-drawer Dialog. */
export function DrawerToggle({ trigger = false }: { trigger?: boolean }) {
  const button = (
    <IconButton label="打开会话抽屉" tooltip={false} size="icon-sm" disabled={!trigger}>
      <PanelLeftIcon />
    </IconButton>
  );
  return (
    <Tooltip content="会话历史（Ctrl/Cmd+B）">
      {trigger ? <DialogPrimitive.Trigger asChild>{button}</DialogPrimitive.Trigger> : button}
    </Tooltip>
  );
}

function RuntimeStatus({ status }: { status: OpenCodeRuntimeStatus | undefined }) {
  const state = status?.state ?? "stopped";
  const label = stateLabels[state];
  const tone = stateTones[state];
  return (
    <span
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-sm border border-line bg-surface-0 px-1.5"
      aria-label={`OpenCode 状态：${label}`}
    >
      <StatusLamp tone={tone} pulse={tone === "run"} />
      <span className="tf-agent-status-label text-2xs text-fg-2">{label}</span>
    </span>
  );
}

function SelectedSessionTitle() {
  const session = useOpenCodeSession();
  return <span className="block truncate text-xs text-fg">{session?.title?.trim() || "新对话"}</span>;
}

export function AgentHeader({ drawerEnabled, drawerTrigger, newThreadTrigger, status, onClose }: HeaderProps & {
  drawerEnabled: boolean;
  drawerTrigger?: ReactNode;
  newThreadTrigger?: ReactNode;
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface-1 ps-1.5 pe-1">
      {drawerTrigger ?? <DrawerToggle trigger={false} />}
      <div className="grid min-w-0 flex-1 gap-px px-1 leading-tight">
        <span className="tf-label">AI 助手</span>
        {drawerEnabled
          ? <SelectedSessionTitle />
          : (
            <span className="block truncate font-mono text-2xs text-fg-3">
              {status?.workspace ?? "testStand Agent"}
            </span>
          )}
      </div>
      <RuntimeStatus status={status} />
      {newThreadTrigger}
      <IconButton label="关闭 AI 助手" size="icon-sm" onClick={onClose}><XIcon /></IconButton>
    </header>
  );
}
