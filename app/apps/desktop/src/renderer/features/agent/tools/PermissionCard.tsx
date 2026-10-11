import {
  type OpenCodePermissionRequest,
  type OpenCodePermissionResponse,
  useOpenCodeRuntimeExtras
} from "@assistant-ui/react-opencode";
import { CheckCircle2Icon, ShieldAlertIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Spinner } from "../../../ui";
import { InteractionCard } from "./interaction-card";
import { toolPreClass } from "./shared";

function replyLabel(reply: OpenCodePermissionResponse) {
  if (reply === "always") return "已始终允许";
  if (reply === "once") return "已允许一次";
  return "已拒绝";
}

const choices: { reply: OpenCodePermissionResponse; label: string; variant: "primary" | "secondary" | "ghost" }[] = [
  { reply: "once", label: "允许一次", variant: "primary" },
  { reply: "always", label: "始终允许", variant: "secondary" },
  { reply: "reject", label: "拒绝", variant: "ghost" }
];

const patternClass =
  "max-w-full rounded-sm border border-line bg-surface-0 px-1.5 font-mono text-2xs leading-5 text-fg-2 wrap-anywhere";

export function OpenCodePermissionCard({
  request,
  state,
  reply
}: {
  request: OpenCodePermissionRequest;
  state: "pending" | "resolved";
  reply?: OpenCodePermissionResponse;
}) {
  const { replyToPermission } = useOpenCodeRuntimeExtras();
  const [submitting, setSubmitting] = useState<OpenCodePermissionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = state === "pending";
  const rejected = reply === "reject";
  const tool = request.toolName ?? request.permission;
  const submit = async (next: OpenCodePermissionResponse) => {
    setSubmitting(next);
    setError(null);
    try { await replyToPermission(request.id, next); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交授权结果失败。");
      setSubmitting(null);
    }
  };
  const hasDetails = request.patterns.length > 0 || request.toolInput !== undefined;
  return (
    <InteractionCard
      tone={pending ? "signal" : rejected ? "fail" : "pass"}
      icon={pending ? <ShieldAlertIcon /> : rejected ? <XCircleIcon /> : <CheckCircle2Icon />}
      title={pending ? "需要操作授权" : replyLabel(reply!)}
      description={request.permission === "doom_loop"
        ? `AI 连续多次用相同参数调用 ${request.patterns[0] ?? "同一个工具"}，可能在原地打转。允许它继续，或拒绝让它换个办法。`
        : request.title ?? `OpenCode 请求执行 ${tool}。`}
      meta={<Badge mono tone={pending ? "signal" : "neutral"} className="max-w-28 truncate normal-case">{tool}</Badge>}
      footer={pending && (
        <>
          {choices.map((choice) => (
            <Button
              key={choice.reply}
              size="xs"
              variant={choice.variant}
              disabled={submitting !== null}
              onClick={() => void submit(choice.reply)}
            >
              {submitting === choice.reply && <Spinner className="size-3" />}
              {choice.label}
            </Button>
          ))}
          {error && <p role="alert" className="w-full text-xs text-fail">{error}</p>}
        </>
      )}
    >
      {hasDetails && (
        <>
          {!!request.patterns.length && (
            <div className="flex flex-wrap gap-1.5">
              {request.patterns.map((pattern) => (
                <code key={pattern} className={patternClass}>
                  {pattern}
                </code>
              ))}
            </div>
          )}
          {request.toolInput !== undefined && (
            <pre className={toolPreClass}>{JSON.stringify(request.toolInput, null, 2)}</pre>
          )}
        </>
      )}
    </InteractionCard>
  );
}
