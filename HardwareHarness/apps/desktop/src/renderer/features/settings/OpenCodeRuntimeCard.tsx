import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OpenCodeRuntimeStatus } from "@hardwareharness/contracts/agents";
import { PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Badge, Button, StatusLamp, type Tone } from "../../ui";
import { PropRow, SettingsCard } from "./SettingsLayout.js";

export const RUNTIME_MUTATION_KEY = ["opencode-runtime-action"] as const;

type RuntimeAction = "start" | "stop" | "restart";

const stateLabels: Record<OpenCodeRuntimeStatus["state"], string> = {
  running: "运行中",
  starting: "启动中",
  stopping: "停止中",
  stopped: "已停止",
  error: "启动失败"
};

/** Start / restart / stop the project's embedded OpenCode runtime. */
export function OpenCodeRuntimeCard({ status, apiKeyConfigured, saving, onError }: {
  status: OpenCodeRuntimeStatus | undefined;
  apiKeyConfigured: boolean;
  /** Model settings are being saved; runtime controls wait for that to settle. */
  saving: boolean;
  onError: (message: string | undefined) => void;
}) {
  const client = useQueryClient();
  const action = useMutation({
    mutationKey: RUNTIME_MUTATION_KEY,
    mutationFn: (kind: RuntimeAction) => {
      const agents = window.hardwareharness.agents;
      if (kind === "start") return agents.startOpenCode();
      if (kind === "stop") return agents.stopOpenCode();
      return agents.restartOpenCode();
    },
    onSuccess: async (next) => {
      onError(undefined);
      client.setQueryData(queryKeys.openCodeStatus, next);
      await client.invalidateQueries({ queryKey: queryKeys.openCodeStatus });
    },
    onError: (reason) => onError(errorMessage(reason))
  });

  const state = status?.state;
  const transitioning = state === "starting" || state === "stopping";
  const busy = saving || action.isPending || transitioning;
  const needsProject = status?.workspaceState === "requires_project";
  const canStart = state === "stopped" || state === "error";
  const startHint = canStart && needsProject ? "需要先打开项目" : canStart && !apiKeyConfigured ? "需要先配置 API Key" : "";
  const tone = runtimeTone(state);

  return (
    <SettingsCard
      title="运行时"
      actions={<Badge tone={tone}>{state ? stateLabels[state] : "读取中"}</Badge>}
      footer={
        <>
          {canStart && (
            <Button
              variant="primary"
              disabled={busy || needsProject || !apiKeyConfigured}
              onClick={() => action.mutate("start")}
            >
              <PlayIcon />
              启动
            </Button>
          )}
          {state === "running" && (
            <Button disabled={busy} onClick={() => action.mutate("restart")}>
              <RefreshCwIcon />
              重启
            </Button>
          )}
          {(state === "running" || state === "starting" || state === "error") && (
            <Button disabled={action.isPending} onClick={() => action.mutate("stop")}>
              <SquareIcon />
              停止
            </Button>
          )}
          {startHint && <span className="text-xs text-fg-3">{startHint}</span>}
        </>
      }
    >
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
        <StatusLamp tone={tone} pulse={transitioning} />
        <div className="grid min-w-0 gap-0.5">
          <strong className="text-sm font-medium text-fg">OpenCode</strong>
          <span className="tf-num text-2xs text-fg-3">
            {status?.version ? `版本 ${status.version}` : "内嵌运行时"}
          </span>
        </div>
      </div>
      <PropRow label="工作区" mono={Boolean(status?.workspace)}>{status?.workspace ?? "需要先打开项目"}</PropRow>
      <PropRow label="状态">{status?.message ?? (needsProject ? "无活动项目时保持停止" : "就绪")}</PropRow>
    </SettingsCard>
  );
}

function runtimeTone(state: OpenCodeRuntimeStatus["state"] | undefined): Tone {
  if (state === "running") return "pass";
  if (state === "error") return "fail";
  if (state === "starting" || state === "stopping") return "run";
  return "neutral";
}
