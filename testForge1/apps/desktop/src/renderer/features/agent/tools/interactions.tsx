import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  type OpenCodePermissionRequest,
  type OpenCodePermissionResponse,
  type OpenCodeQuestionRequest,
  type QuestionAnswer,
  useOpenCodeThreadState
} from "@assistant-ui/react-opencode";
import { CheckCircle2Icon, CircleHelpIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { OpenCodePermissionCard } from "./PermissionCard";
import { getQuestionSummary, OpenCodeQuestionCard } from "./QuestionCard";

type PermissionInteraction = { request: OpenCodePermissionRequest; state: "pending" | "resolved"; reply?: OpenCodePermissionResponse };
type QuestionInteraction = { request: OpenCodeQuestionRequest; state: "pending" | "answered" | "rejected"; answers?: readonly QuestionAnswer[] };

function useInteractions(toolCallId?: string) {
  const interactions = useOpenCodeThreadState((state) => state.interactions);
  return useMemo(() => {
    const permissions: PermissionInteraction[] = [];
    const questions: QuestionInteraction[] = [];
    const matches = (callId: string | undefined) => toolCallId ? callId === toolCallId : !callId;
    for (const request of Object.values(interactions.permissions.pending)) if (matches(request.tool?.callID)) permissions.push({ request, state: "pending" });
    for (const resolved of Object.values(interactions.permissions.resolved)) if (matches(resolved.request.tool?.callID)) permissions.push({ request: resolved.request, state: "resolved", reply: resolved.reply });
    for (const request of Object.values(interactions.questions.pending)) if (matches(request.tool?.callID)) questions.push({ request, state: "pending" });
    for (const answered of Object.values(interactions.questions.answered)) if (matches(answered.request.tool?.callID)) questions.push({ request: answered.request, state: "answered", answers: answered.answers });
    for (const rejected of Object.values(interactions.questions.rejected)) if (matches(rejected.request.tool?.callID)) questions.push({ request: rejected.request, state: "rejected" });
    return { permissions, questions };
  }, [interactions, toolCallId]);
}

function InteractionStack({ toolCallId }: { toolCallId?: string }) {
  const { permissions, questions } = useInteractions(toolCallId);
  if (!permissions.length && !questions.length) return null;
  return (
    <div className="space-y-3">
      {permissions.map((item) => <OpenCodePermissionCard key={`${item.request.id}-${item.state}`} request={item.request} state={item.state} {...(item.reply ? { reply: item.reply } : {})} />)}
      {questions.map((item) => <OpenCodeQuestionCard key={`${item.request.id}-${item.state}`} request={item.request} state={item.state} {...(item.answers ? { answers: item.answers } : {})} />)}
    </div>
  );
}

export function withOpenCodeToolInteractions<TArgs = any, TResult = any>(Base: ToolCallMessagePartComponent<TArgs, TResult>): ToolCallMessagePartComponent<TArgs, TResult> {
  const Wrapped: ToolCallMessagePartComponent<TArgs, TResult> = memo((props) => (
    <div className="space-y-3"><Base {...props} /><InteractionStack toolCallId={props.toolCallId} /></div>
  ));
  Wrapped.displayName = `withOpenCodeToolInteractions(${Base.displayName || Base.name || "Tool"})`;
  return Wrapped;
}

const QUESTION_TOOL_NAMES = ["ask_question", "request_user_input", "requestUserInput"] as const;
export const AskQuestionInline: ToolCallMessagePartComponent = memo(({ toolCallId, toolName, status }) => {
  const { questions } = useInteractions(toolCallId);
  const label = getQuestionSummary(questions[0]?.request);
  const type = status?.type ?? "complete";
  return (
    <div className="flex items-center gap-2 py-0.5 text-sm text-muted-foreground">
      {type === "requires-action" ? <CircleHelpIcon className="size-3.5 shrink-0" /> : type === "running" ? <LoaderIcon className="size-3.5 shrink-0 animate-spin" /> : type === "incomplete" ? <XCircleIcon className="size-3.5 shrink-0 text-destructive" /> : <CheckCircle2Icon className="size-3.5 shrink-0" />}
      <span className="flex min-w-0 items-center gap-1.5 truncate"><span className="font-medium">{QUESTION_TOOL_NAMES.includes(toolName as (typeof QUESTION_TOOL_NAMES)[number]) ? "ask_question" : toolName}</span><span className="truncate opacity-60">{label}</span></span>
    </div>
  );
});
AskQuestionInline.displayName = "AskQuestionInline";
