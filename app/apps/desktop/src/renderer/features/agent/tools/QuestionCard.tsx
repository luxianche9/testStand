import {
  type OpenCodeQuestionRequest,
  type QuestionAnswer,
  useOpenCodeRuntimeExtras
} from "@assistant-ui/react-opencode";
import { AlertCircleIcon, CheckCircle2Icon, CircleHelpIcon, XCircleIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Checkbox, Label, Spinner, Textarea } from "../../../ui";
import { InteractionCard } from "./interaction-card";

type PendingQuestionState = { selectedLabels: string[]; customAnswer: string };
type Question = OpenCodeQuestionRequest["questions"][number];
type Update = (fn: (current: PendingQuestionState) => PendingQuestionState) => void;

const emptyState = (request: OpenCodeQuestionRequest): PendingQuestionState[] =>
  request.questions.map(() => ({ selectedLabels: [], customAnswer: "" }));

function encodeAnswers(request: OpenCodeQuestionRequest, form: PendingQuestionState[]): QuestionAnswer[] {
  return request.questions.map((question, index) => {
    const current = form[index];
    if (!current) return [];
    const answers = [...current.selectedLabels];
    const custom = current.customAnswer.trim();
    if (question.custom !== false && custom) answers.push(`Other: ${custom}`);
    return answers;
  });
}

export function getQuestionSummary(request?: OpenCodeQuestionRequest) {
  if (!request?.questions.length) return "等待输入";
  if (request.questions.length === 1) return request.questions[0]?.header || "1 个问题";
  return `${request.questions.length} 个问题`;
}

type OptionProps = { id: string; question: Question; current: PendingQuestionState; update: Update };

function MultipleOptions({ id, question, current, update }: OptionProps) {
  return (
    <div className="grid gap-1.5">
      {question.options.map((option, optionIndex) => {
        const checked = current.selectedLabels.includes(option.label);
        const optionId = `${id}-${optionIndex}`;
        const toggle = (next: boolean | "indeterminate") => update((item) => ({
          ...item,
          selectedLabels: next === true
            ? [...item.selectedLabels, option.label]
            : item.selectedLabels.filter((label) => label !== option.label)
        }));
        return (
          <div
            key={option.label}
            className="flex items-start gap-2.5 rounded-sm border border-line bg-surface-0/60 px-2.5 py-2"
          >
            <Checkbox id={optionId} checked={checked} className="mt-0.5" onCheckedChange={toggle} />
            <div className="grid min-w-0 gap-0.5">
              <Label htmlFor={optionId} className="text-sm text-fg">{option.label}</Label>
              {option.description && <p className="text-xs text-fg-3">{option.description}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SingleOptions({ question, current, update }: Omit<OptionProps, "id">) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {question.options.map((option) => {
        const selected = current.selectedLabels.includes(option.label);
        return (
          <Button
            key={option.label}
            size="xs"
            variant={selected ? "primary" : "outline"}
            aria-pressed={selected}
            title={option.description}
            onClick={() => update((item) => ({ ...item, selectedLabels: [option.label], customAnswer: "" }))}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

function PendingQuestion({ id, question, current, update }: OptionProps) {
  const customId = `${id}-custom`;
  return (
    <>
      {!!question.options.length && (question.multiple
        ? <MultipleOptions id={id} question={question} current={current} update={update} />
        : <SingleOptions question={question} current={current} update={update} />)}
      {question.custom !== false && (
        <div className="grid gap-1">
          <Label htmlFor={customId}>其他回答</Label>
          <Textarea
            id={customId}
            rows={3}
            value={current.customAnswer}
            placeholder="输入自定义回答"
            onChange={(event) => {
              const value = event.target.value;
              update((item) => ({
                ...item,
                customAnswer: value,
                selectedLabels: question.multiple || !value.trim() ? item.selectedLabels : []
              }));
            }}
          />
        </div>
      )}
    </>
  );
}

export function OpenCodeQuestionCard({
  request,
  state,
  answers
}: {
  request: OpenCodeQuestionRequest;
  state: "pending" | "answered" | "rejected";
  answers?: readonly QuestionAnswer[];
}) {
  const { replyToQuestion, rejectQuestion } = useOpenCodeRuntimeExtras();
  const [form, setForm] = useState(() => emptyState(request));
  const [submitting, setSubmitting] = useState<"reply" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = state === "pending";
  const rejected = state === "rejected";
  const encoded = useMemo(() => encodeAnswers(request, form), [form, request]);
  const canSubmit = pending && encoded.every((answer) => answer.length > 0);
  const update = (index: number, fn: (current: PendingQuestionState) => PendingQuestionState) =>
    setForm((current) => current.map((item, itemIndex) => itemIndex === index ? fn(item) : item));
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting("reply");
    setError(null);
    try { await replyToQuestion(request.id, encoded); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交回答失败。");
      setSubmitting(null);
    }
  };
  const reject = async () => {
    setSubmitting("reject");
    setError(null);
    try { await rejectQuestion(request.id); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "跳过问题失败。");
      setSubmitting(null);
    }
  };
  return (
    <InteractionCard
      tone={pending ? "signal" : rejected ? "neutral" : "pass"}
      icon={pending ? <CircleHelpIcon /> : rejected ? <XCircleIcon /> : <CheckCircle2Icon />}
      title={pending ? "需要你的回答" : rejected ? "已跳过问题" : "回答已提交"}
      description={getQuestionSummary(request)}
      meta={<Badge tone={pending ? "signal" : "neutral"} className="tf-num">{request.questions.length} 项</Badge>}
      footer={pending && (
        <>
          <Button
            size="xs"
            variant="primary"
            disabled={!canSubmit || submitting !== null}
            onClick={() => void submit()}
          >
            {submitting === "reply" && <Spinner className="size-3" />}
            提交回答
          </Button>
          <Button size="xs" variant="ghost" disabled={submitting !== null} onClick={() => void reject()}>
            {submitting === "reject" && <Spinner className="size-3" />}
            跳过
          </Button>
          {error && (
            <p role="alert" className="flex w-full items-center gap-1.5 text-xs text-fail">
              <AlertCircleIcon aria-hidden className="size-3.5" />
              {error}
            </p>
          )}
        </>
      )}
    >
      {request.questions.map((question, index) => {
        const id = `${request.id}-${index}`;
        const current = form[index] ?? { selectedLabels: [], customAnswer: "" };
        const answered = answers?.[index] ?? [];
        return (
          <section key={id} className="grid gap-2 border-t border-line pt-2.5 first:border-t-0 first:pt-0">
            <div className="grid gap-0.5">
              <p className="text-sm font-medium text-fg">{question.header}</p>
              <p className="text-xs leading-5 text-fg-2">{question.question}</p>
            </div>
            {pending ? (
              <PendingQuestion id={id} question={question} current={current} update={(fn) => update(index, fn)} />
            ) : rejected ? (
              <p className="text-xs text-fg-3">没有提交回答。</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {answered.map((answer) => <Badge key={answer} tone="pass">{answer}</Badge>)}
              </div>
            )}
          </section>
        );
      })}
    </InteractionCard>
  );
}
