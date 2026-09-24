import {
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps
} from "@assistant-ui/react";
import { ShieldAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../ui";

const APPROVED_RESULT = "Approved by user";
const DENIED_RESULT = "User denied tool execution";

const optionLabels: Record<string, string> = {
  "allow-once": "允许一次",
  "allow-always": "始终允许",
  "reject-once": "拒绝",
  "reject-always": "始终拒绝"
};
const isAllow = (kind: string) => kind === "allow-once" || kind === "allow-always";
const optionLabel = (option: ToolApprovalOption) => option.label ?? optionLabels[option.kind] ?? option.id;

/** Signal-accented strip for tool approval decisions. */
function ApprovalFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid gap-2 overflow-hidden rounded-sm border border-signal/45 bg-signal/6 py-2 pr-2 pl-3">
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-signal" />
      {children}
    </div>
  );
}

function ApprovalButtons({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ShieldAlertIcon aria-hidden className="size-3.5 text-signal" />
      {children}
    </div>
  );
}

export function ToolFallbackApproval({
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval
}: Partial<Pick<ToolCallMessagePartProps, "addResult" | "resume" | "respondToApproval">> & {
  interrupt?: ToolCallMessagePart["interrupt"];
  approval?: ToolCallMessagePart["approval"];
}) {
  const [submitted, setSubmitted] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  if (approval && (approval.approved !== undefined || approval.resolution !== undefined)) return null;
  const declared = respondToApproval ? approval?.options : undefined;
  const options = declared?.filter((option) => option.kind in optionLabels) ?? [];

  const respond = (approved: boolean) => {
    if (submitted) return;
    if (approval && approval.approved === undefined && respondToApproval) respondToApproval({ approved });
    else if (interrupt) resume?.({ approved });
    else addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
    setSubmitted(true);
  };
  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return;
    respondToApproval?.({ optionId: option.id });
    setSubmitted(true);
    setConfirmingId(null);
  };
  const confirming = options.find((option) => option.id === confirmingId);
  if (confirming) {
    const meta = typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const description = meta?.description ?? confirming.description;
    return (
      <ApprovalFrame>
        <p className="text-sm font-medium text-fg">{meta?.title ?? `确认“${optionLabel(confirming)}”？`}</p>
        {description && <p className="text-xs leading-5 text-fg-2">{description}</p>}
        {confirming.grants?.map((grant) => (
          <code key={grant} className="w-fit rounded-sm bg-surface-0 px-1.5 py-0.5 font-mono text-xs text-fg-2">
            {grant}
          </code>
        ))}
        <div className="flex gap-1.5">
          <Button size="xs" variant="primary" disabled={submitted} onClick={() => respondWithOption(confirming)}>
            确认
          </Button>
          <Button size="xs" variant="ghost" disabled={submitted} onClick={() => setConfirmingId(null)}>返回</Button>
        </div>
      </ApprovalFrame>
    );
  }

  if (declared?.length) {
    const allow = options.filter((option) => isAllow(option.kind));
    const reject = options.filter((option) => !isAllow(option.kind));
    return (
      <ApprovalFrame>
        <ApprovalButtons>
          {[...allow, ...reject].map((option) => (
            <Button
              key={option.id}
              size="xs"
              variant={option === allow[0] ? "primary" : "outline"}
              disabled={submitted}
              onClick={() => option.confirm ? setConfirmingId(option.id) : respondWithOption(option)}
            >
              {optionLabel(option)}
            </Button>
          ))}
          {!reject.length && (
            <Button size="xs" variant="outline" disabled={submitted} onClick={() => respond(false)}>拒绝</Button>
          )}
        </ApprovalButtons>
      </ApprovalFrame>
    );
  }

  return (
    <ApprovalFrame>
      <ApprovalButtons>
        <Button size="xs" variant="primary" disabled={submitted} onClick={() => respond(true)}>允许</Button>
        <Button size="xs" variant="outline" disabled={submitted} onClick={() => respond(false)}>拒绝</Button>
      </ApprovalButtons>
    </ApprovalFrame>
  );
}
