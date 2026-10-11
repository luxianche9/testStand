import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  type OpenCodePermissionRequest,
  type OpenCodePermissionResponse,
  type OpenCodeQuestionRequest,
  type QuestionAnswer,
  useOpenCodeThreadState
} from "@assistant-ui/react-opencode";
import { memo, useMemo } from "react";
import { OpenCodePermissionCard } from "./PermissionCard";
import { getQuestionSummary, OpenCodeQuestionCard } from "./QuestionCard";
import { toolCardClass, ToolHeading, ToolLamp, toolRowClass } from "./shared";

type PermissionInteraction = {
  request: OpenCodePermissionRequest;
  state: "pending" | "resolved";
  reply?: OpenCodePermissionResponse;
};
type QuestionInteraction = {
  request: OpenCodeQuestionRequest;
  state: "pending" | "answered" | "rejected";
  answers?: readonly QuestionAnswer[];
};

function useInteractions(toolCallId?: string) {
  const interactions = useOpenCodeThreadState((state) => state.interactions);
  return useMemo(() => {
    const permissions: PermissionInteraction[] = [];
    const questions: QuestionInteraction[] = [];
    const matches = (callId: string | undefined) => toolCallId ? callId === toolCallId : !callId;
    const { permissions: perms, questions: asks } = interactions;
    for (const request of Object.values(perms.pending)) {
      if (matches(request.tool?.callID)) permissions.push({ request, state: "pending" });
    }
    for (const resolved of Object.values(perms.resolved)) {
      if (!matches(resolved.request.tool?.callID)) continue;
      permissions.push({ request: resolved.request, state: "resolved", reply: resolved.reply });
    }
    for (const request of Object.values(asks.pending)) {
      if (matches(request.tool?.callID)) questions.push({ request, state: "pending" });
    }
    for (const answered of Object.values(asks.answered)) {
      if (!matches(answered.request.tool?.callID)) continue;
      questions.push({ request: answered.request, state: "answered", answers: answered.answers });
    }
    for (const rejected of Object.values(asks.rejected)) {
      if (matches(rejected.request.tool?.callID)) questions.push({ request: rejected.request, state: "rejected" });
    }
    return { permissions, questions };
  }, [interactions, toolCallId]);
}

function InteractionStack({ toolCallId }: { toolCallId?: string }) {
  const { permissions, questions } = useInteractions(toolCallId);
  if (!permissions.length && !questions.length) return null;
  return (
    <div className="grid gap-2">
      {permissions.map((item) => (
        <OpenCodePermissionCard
          key={`${item.request.id}-${item.state}`}
          request={item.request}
          state={item.state}
          {...(item.reply ? { reply: item.reply } : {})}
        />
      ))}
      {questions.map((item) => (
        <OpenCodeQuestionCard
          key={`${item.request.id}-${item.state}`}
          request={item.request}
          state={item.state}
          {...(item.answers ? { answers: item.answers } : {})}
        />
      ))}
    </div>
  );
}

/**
 * Pending requests that belong to no tool call (OpenCode's repeated-call guard, `doom_loop`, has
 * `tool: null`). Rendered above the composer: without it the agent would wait forever.
 */
export function UnattachedInteractions() {
  const { permissions, questions } = useInteractions();
  const pending = permissions.filter((item) => item.state === "pending");
  const asking = questions.filter((item) => item.state === "pending");
  if (!pending.length && !asking.length) return null;
  return (
    <div className="grid gap-2" aria-label="等待你处理的请求">
      {pending.map((item) => <OpenCodePermissionCard key={item.request.id} request={item.request} state="pending" />)}
      {asking.map((item) => <OpenCodeQuestionCard key={item.request.id} request={item.request} state="pending" />)}
    </div>
  );
}

export function withOpenCodeToolInteractions<TArgs = any, TResult = any>(
  Base: ToolCallMessagePartComponent<TArgs, TResult>
): ToolCallMessagePartComponent<TArgs, TResult> {
  const Wrapped: ToolCallMessagePartComponent<TArgs, TResult> = memo((props) => (
    <div className="grid gap-2">
      <Base {...props} />
      <InteractionStack toolCallId={props.toolCallId} />
    </div>
  ));
  Wrapped.displayName = `withOpenCodeToolInteractions(${Base.displayName || Base.name || "Tool"})`;
  return Wrapped;
}

const QUESTION_TOOL_NAMES: readonly string[] = ["ask_question", "request_user_input", "requestUserInput"];

export const AskQuestionInline: ToolCallMessagePartComponent = memo(({ toolCallId, toolName, status }) => {
  const { questions } = useInteractions(toolCallId);
  const label = getQuestionSummary(questions[0]?.request);
  return (
    <div className={toolCardClass}>
      <div className={toolRowClass}>
        <ToolLamp status={status} />
        <ToolHeading name={QUESTION_TOOL_NAMES.includes(toolName) ? "ask_question" : toolName} detail={label} prose />
      </div>
    </div>
  );
});
AskQuestionInline.displayName = "AskQuestionInline";
